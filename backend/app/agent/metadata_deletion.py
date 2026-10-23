"""Review snapshots and undo guards for deleting only knowledge metadata.

Callers hold the knowledge-base namespace lock before writing. Folder deletion
is soft; deleted tag rows and document associations are restored by undo.
"""

from datetime import datetime

from sqlalchemy import select

from app.core.errors import AppError
from app.db.models import Document, DocumentTag, Folder, Tag
from app.services import library

MAX_TAG_DOCUMENTS = 500


def deleted_tag_ids(draft):
    return sorted({identifier for op in draft.operations if op.enabled and op.type == "delete_tags"
                   for identifier in op.target_ids})


def tag_links(db, kb_id, tag_ids):
    result = {identifier: [] for identifier in tag_ids}
    if not result:
        return result
    rows = db.execute(select(DocumentTag.tag_id, DocumentTag.document_id).where(
        DocumentTag.kb_id == kb_id, DocumentTag.tag_id.in_(tag_ids),
    ).order_by(DocumentTag.tag_id, DocumentTag.document_id).limit(MAX_TAG_DOCUMENTS + 1)).all()
    if len(rows) > MAX_TAG_DOCUMENTS:
        raise AppError("organization_scope_too_large", "一次删除标签最多影响500条关联，请减少标签数量后重试", 409)
    for tag_id, document_id in rows:
        result[tag_id].append(document_id)
    return result


def capture_tag_links(db, kb_id, draft, previous=None):
    snapshot = tag_links(db, kb_id, deleted_tag_ids(draft))
    if previous is not None:
        # Editing may deselect deletions, but cannot silently accept new links.
        for tag_id, ids in snapshot.items():
            if tag_id in previous and ids != sorted(previous[tag_id]):
                raise AppError("version_conflict", "标签关联已变化，请重新生成并审阅计划", 409,
                               {"resource": f"tag:{tag_id}"})
    return snapshot


def check_tag_links(db, data):
    snapshot = tag_links(db, data.kb_id, deleted_tag_ids(data))
    if snapshot != {identifier: sorted(data.base_tag_links.get(identifier, [])) for identifier in snapshot}:
        raise AppError("version_conflict", "标签关联已变化，请重新生成并审阅计划", 409)
    for document_id in sorted({identifier for ids in snapshot.values() for identifier in ids}):
        doc = db.scalar(select(Document).where(Document.id == document_id, Document.kb_id == data.kb_id)
                        .with_for_update().execution_options(populate_existing=True))
        if not doc or data.base_versions.get(f"document:{document_id}") != doc.version:
            raise AppError("version_conflict", "标签所关联的文档已变化，请重新生成并审阅计划", 409,
                           {"resource": f"document:{document_id}"})


def require_empty_folder(db, kb_id, folder_id):
    has_docs = db.scalar(select(Document.id).where(Document.kb_id == kb_id, Document.folder_id == folder_id,
                                                  Document.deleted_at.is_(None)).limit(1))
    has_children = db.scalar(select(Folder.id).where(Folder.kb_id == kb_id, Folder.parent_id == folder_id,
                                                    Folder.deleted_at.is_(None)).limit(1))
    if has_docs or has_children:
        raise AppError("folder_not_empty", "文件夹中仍有文档或子文件夹，只能删除空文件夹", 409,
                       {"resource": f"folder:{folder_id}"})


def validate_deletions(db, data):
    deleted_tags = set(deleted_tag_ids(data))
    deleted_folders = {identifier for op in data.operations if op.enabled and op.type == "trash_empty_folders"
                       for identifier in op.target_ids}
    seen = set()
    deleted_tag_names = {library.normalized_name(name) for tag in db.scalars(select(Tag).where(Tag.id.in_(deleted_tags)))
                         for name in [tag.name, *tag.aliases]}
    for op in data.operations:
        if not op.enabled:
            continue
        if op.type in {"delete_tags", "trash_empty_folders"}:
            keys = {(op.type, identifier) for identifier in op.target_ids}
            if seen & keys:
                raise AppError("conflicting_operations", "同一删除目标不能重复执行", 409)
            seen.update(keys)
        if op.type == "trash_empty_folders":
            for folder_id in op.target_ids:
                require_empty_folder(db, data.kb_id, folder_id)
        if op.type == "update_document_tags" and deleted_tags & set(op.params.tag_ids):
            raise AppError("conflicting_operations", "不能在同一方案中分配并删除同一个标签", 409)
        if op.type == "update_document_tags" and deleted_tag_names & {library.normalized_name(name) for name in op.params.new_tag_names}:
            raise AppError("conflicting_operations", "不能同时分配和删除同名标签或别名", 409)
        destination = op.params.parent_id if op.type == "create_folder" else getattr(op.params, "folder_id", None)
        if destination in deleted_folders:
            raise AppError("conflicting_operations", "不能将文档或新目录放入将被删除的文件夹", 409)
        if op.type == "rename_folder" and set(op.target_ids) & deleted_folders:
            raise AppError("conflicting_operations", "不能在同一方案中重命名并删除同一文件夹", 409)


def check_deleted_tag_restore(db, kb_id, records):
    """Validate every tombstone before changing any row or association."""
    deleted = [record for record in records if record.entity_type == "tag" and record.before.get("deleted")]
    if not deleted:
        return []
    current = list(db.scalars(select(Tag).where(Tag.kb_id == kb_id).with_for_update()))
    names = {library.normalized_name(name) for tag in current for name in [tag.name, *tag.aliases]}
    ids = {tag.id for tag in current}
    for record in deleted:
        original = record.before["tag"]
        keys = {library.normalized_name(name) for name in [original["name"], *original["aliases"]]}
        if record.entity_id in ids or db.get(Tag, record.entity_id) is not None or keys & names:
            raise AppError("undo_conflict", "已存在同名标签或别名，不能安全恢复已删除标签", 409,
                           {"resource": f"tag:{record.entity_id}"})
        names.update(keys)
        ids.add(record.entity_id)
    return deleted


def restore_deleted_tag(db, record):
    data = dict(record.before["tag"])
    for field in ("created_at", "updated_at"):
        if isinstance(data.get(field), str):
            data[field] = datetime.fromisoformat(data[field])
    data["version"] = record.after_version + 1
    tag = Tag(**data)
    db.add(tag)
    db.flush()
    return tag


def restore_folder(db, actor, folder, before):
    if not folder.deleted_at:
        return library.update_folder(db, actor, folder.id, {"name": before["name"], "parent_id": before["parent_id"]})
    library.validate_folder(db, folder.kb_id, before["parent_id"])
    library.folder_name_conflict(db, folder.kb_id, before["parent_id"], before["name"], folder.id)
    folder.name, folder.parent_id = before["name"], before["parent_id"]
    folder.deleted_at = datetime.fromisoformat(before["deleted_at"]) if before.get("deleted_at") else None
    folder.version += 1
    return folder
