import unicodedata
from collections import defaultdict, deque
from datetime import datetime

from sqlalchemy import delete, select

from app.core.errors import AppError
from app.db.models import AuditLog, Document, DocumentTag, Folder, KnowledgeBase, Tag, utcnow
from app.services.permissions import assert_can_edit_kb, assert_can_read_kb


def normalized_name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def valid_name(value: str, limit=160) -> str:
    if not isinstance(value, str):
        raise AppError("invalid_name", f"名称不能为空，且最多 {limit} 个字符")
    value = value.strip()
    if not value or len(value) > limit or any(ord(c) < 32 for c in value):
        raise AppError("invalid_name", f"名称不能为空，且最多 {limit} 个字符")
    return value


def version_check(entity, expected):
    if expected is not None and entity.version != expected:
        raise AppError("version_conflict", "数据已被修改，请刷新后重新操作", 409)


def validate_folder(db, kb_id, folder_id):
    if folder_id is None:
        return None
    folder = db.get(Folder, folder_id)
    if not folder or folder.kb_id != kb_id or folder.deleted_at:
        raise AppError("invalid_folder", "文件夹不存在、已删除或属于其他知识库", 400)
    return folder


def descendants(db, kb_id, folder_ids):
    found = set(folder_ids)
    if not found:
        return found
    # Build the adjacency map once. Repeated whole-tree scans grow quadratically
    # with directory depth, and loading full ORM entities is unnecessary here.
    rows = list(db.execute(select(Folder.id, Folder.parent_id).where(
        Folder.kb_id == kb_id, Folder.deleted_at.is_(None))))
    if not found.issubset({folder_id for folder_id, _ in rows}):
        raise AppError("invalid_folder", "文件夹不存在、已删除或属于其他知识库", 400)
    children = defaultdict(list)
    for folder_id, parent_id in rows:
        children[parent_id].append(folder_id)
    pending = deque(found)
    while pending:
        for child_id in children[pending.popleft()]:
            if child_id not in found:
                found.add(child_id)
                pending.append(child_id)
    return found


def folder_name_conflict(db, kb_id, parent_id, name, exclude=None):
    rows = db.scalars(select(Folder).where(Folder.kb_id == kb_id, Folder.parent_id == parent_id, Folder.deleted_at.is_(None)))
    if any(f.id != exclude and normalized_name(f.name) == normalized_name(name) for f in rows):
        raise AppError("duplicate_folder", "同一目录下已存在同名文件夹", 409)


def lock_kb_namespace(db, actor, kb_id):
    """Serialize metadata writes before entity locks, including tree/alias checks."""
    kb = lock_metadata_entity(db, KnowledgeBase, kb_id, None, "知识库")
    return assert_can_edit_kb(db, actor, kb.id)


def lock_metadata_entity(db, model, entity_id, kb_id, label):
    """Re-read under lock; kb_id scopes children of an already locked KB."""
    query = select(model).where(model.id == entity_id)
    if kb_id is not None:
        query = query.where(model.kb_id == kb_id)
    value = db.scalar(query.with_for_update().execution_options(populate_existing=True))
    if value is None:
        raise AppError("not_found", f"{label}不存在", 404)
    return value


def create_folder(db, actor, kb_id, data):
    lock_kb_namespace(db, actor, kb_id)
    validate_folder(db, kb_id, data.get("parent_id"))
    name = valid_name(data["name"])
    folder_name_conflict(db, kb_id, data.get("parent_id"), name)
    folder = Folder(kb_id=kb_id, parent_id=data.get("parent_id"), name=name)
    db.add(folder)
    db.flush()
    audit(db, actor, kb_id, "create_folder", folder.id, {}, snapshot(folder))
    return folder


def update_folder(db, actor, folder_id, data):
    folder = db.get(Folder, folder_id)
    if not folder:
        raise AppError("not_found", "文件夹不存在", 404)
    lock_kb_namespace(db, actor, folder.kb_id)
    folder = lock_metadata_entity(db, Folder, folder_id, folder.kb_id, "文件夹")
    version_check(folder, data.get("version"))
    before = snapshot(folder)
    parent_id = data.get("parent_id", folder.parent_id)
    validate_folder(db, folder.kb_id, parent_id)
    if parent_id in descendants(db, folder.kb_id, [folder.id]):
        raise AppError("folder_cycle", "不能移动到自身或子文件夹")
    name = valid_name(data.get("name", folder.name))
    folder_name_conflict(db, folder.kb_id, parent_id, name, folder.id)
    folder.name, folder.parent_id = name, parent_id
    folder.version += 1
    audit(db, actor, folder.kb_id, "update_folder", folder.id, before, snapshot(folder))
    return folder


def get_document(db, actor, doc_id, include_deleted=False):
    doc = db.get(Document, doc_id)
    if not doc or (doc.deleted_at and not include_deleted):
        raise AppError("not_found", "文档不存在或已删除", 404)
    assert_can_read_kb(db, actor, doc.kb_id)
    if doc.folder_id and not include_deleted:
        validate_folder(db, doc.kb_id, doc.folder_id)
    return doc


def set_document_tags(db, doc, tag_ids, mode="set"):
    if tag_ids is None:
        raise AppError("invalid_tags", "标签列表不能为空值；使用空列表清除标签")
    ids = set(tag_ids)
    tags = list(db.scalars(select(Tag).where(Tag.id.in_(ids)))) if ids else []
    if len(tags) != len(ids) or any(t.kb_id != doc.kb_id for t in tags):
        raise AppError("invalid_tags", "标签不存在或属于其他知识库")
    current = set(db.scalars(select(DocumentTag.tag_id).where(DocumentTag.document_id == doc.id)))
    final = ids if mode == "set" else (current | ids if mode == "add" else current - ids)
    db.execute(delete(DocumentTag).where(DocumentTag.document_id == doc.id))
    for tag_id in final:
        db.add(DocumentTag(document_id=doc.id, tag_id=tag_id, kb_id=doc.kb_id))
    db.flush()


def update_document(db, actor, doc_id, data):
    doc = db.get(Document, doc_id)
    if not doc:
        raise AppError("not_found", "文档不存在", 404)
    lock_kb_namespace(db, actor, doc.kb_id)
    doc = lock_metadata_entity(db, Document, doc_id, doc.kb_id, "文档")
    version_check(doc, data.get("version"))
    before = document_snapshot(db, doc)
    if "display_name" in data:
        doc.display_name = valid_name(data["display_name"], 255)
    if "folder_id" in data:
        validate_folder(db, doc.kb_id, data["folder_id"])
        doc.folder_id = data["folder_id"]
    if "tag_ids" in data:
        set_document_tags(db, doc, data["tag_ids"], data.get("tag_mode", "set"))
    if "deleted_at" in data:
        doc.deleted_at = utcnow() if data["deleted_at"] else None
        if not doc.deleted_at and doc.folder_id:
            validate_folder(db, doc.kb_id, doc.folder_id)
    doc.version += 1
    db.flush()
    audit(db, actor, doc.kb_id, "update_document", doc.id, before, document_snapshot(db, doc))
    return doc


def _batch_documents(db, actor, kb_id, ids):
    # Never lock a document in another namespace. The error path may inspect
    # missing IDs to preserve the existing cross-KB/permission errors.
    documents = list(db.scalars(select(Document).where(Document.kb_id == kb_id, Document.id.in_(ids))
        .order_by(Document.id).with_for_update().execution_options(populate_existing=True)))
    missing = set(ids) - {doc.id for doc in documents}
    if missing:
        for doc in db.scalars(select(Document).where(Document.id.in_(missing))):
            assert_can_read_kb(db, actor, doc.kb_id)
            if doc.kb_id != kb_id:
                raise AppError("cross_kb", "不支持跨知识库批量操作")
        raise AppError("not_found", "文档不存在", 404)
    return documents


def _batch_folders(db, kb_id, documents, data):
    ids = {data["folder_id"]} if "folder_id" in data and data["folder_id"] is not None else set()
    if "deleted_at" in data and not data["deleted_at"]:
        ids |= {data.get("folder_id", doc.folder_id) for doc in documents}
    ids.discard(None)
    if not ids:
        return
    # Refresh cached folders only after acquiring the namespace lock. A parent
    # can have been deleted while this transaction waited for that lock.
    folders = list(db.scalars(select(Folder).where(Folder.kb_id == kb_id, Folder.id.in_(ids))
        .execution_options(populate_existing=True)))
    if len(folders) != len(ids) or any(folder.deleted_at for folder in folders):
        raise AppError("invalid_folder", "文件夹不存在、已删除或属于其他知识库", 400)


def _batch_tags(db, kb_id, ids, before, data):
    current = {item["id"]: set(item["tag_ids"]) for item in before}
    if "tag_ids" not in data:
        return current
    if data["tag_ids"] is None:
        raise AppError("invalid_tags", "标签列表不能为空值；使用空列表清除标签")
    target, mode = set(data["tag_ids"]), data.get("tag_mode", "set")
    if mode not in {"set", "add", "remove"}:
        raise AppError("invalid_tag_mode", "不支持的标签更新方式")
    tags = list(db.scalars(select(Tag).where(Tag.id.in_(target))
        .execution_options(populate_existing=True))) if target else []
    if len(tags) != len(target) or any(tag.kb_id != kb_id for tag in tags):
        raise AppError("invalid_tags", "标签不存在或属于其他知识库")
    final = {doc_id: target if mode == "set" else previous | target if mode == "add" else previous - target
        for doc_id, previous in current.items()}
    if any(previous - final[doc_id] for doc_id, previous in current.items()):
        remove = delete(DocumentTag).where(DocumentTag.document_id.in_(ids))
        if mode == "set" and target:
            remove = remove.where(DocumentTag.tag_id.not_in(target))
        elif mode == "remove":
            remove = remove.where(DocumentTag.tag_id.in_(target))
        db.execute(remove)
    db.add_all(DocumentTag(document_id=doc_id, tag_id=tag_id, kb_id=kb_id)
        for doc_id, previous in current.items() for tag_id in sorted(final[doc_id] - previous))
    return final


def update_documents(db, actor, kb_id, document_ids, data):
    """Apply one bounded metadata operation atomically, with per-file audit."""
    ids = list(dict.fromkeys(document_ids))
    if not ids or len(ids) > 200:
        raise AppError("invalid_batch", "请选择 1 至 200 份文档")
    kb = lock_kb_namespace(db, actor, kb_id)
    documents = _batch_documents(db, actor, kb.id, ids)
    _batch_folders(db, kb.id, documents, data)
    before = document_snapshots(db, documents)
    tags = _batch_tags(db, kb.id, ids, before, data)
    deleted_at = utcnow() if data.get("deleted_at") else None
    for doc in documents:
        if "folder_id" in data:
            doc.folder_id = data["folder_id"]
        if "deleted_at" in data:
            doc.deleted_at = deleted_at
        # Even a no-op is an explicit successful operation in the existing API.
        doc.version += 1
    # Validate every resource before mutations can autoflush. One flush also
    # makes updated_at available to both the response and the audit snapshots.
    db.flush()
    results = {}
    for doc, previous in zip(documents, before, strict=True):
        after = {**snapshot(doc), "tag_ids": sorted(tags[doc.id])}
        audit(db, actor, kb.id, "update_document", doc.id, previous, after)
        results[doc.id] = after
    return [results[doc_id] for doc_id in ids]


def snapshot(entity):
    return {c.name: (v.isoformat() if isinstance(v := getattr(entity, c.name), datetime) else v) for c in entity.__table__.columns}


def document_snapshot(db, doc):
    data = snapshot(doc)
    data["tag_ids"] = list(db.scalars(select(DocumentTag.tag_id).where(DocumentTag.document_id == doc.id)))
    return data


def document_snapshots(db, documents):
    """Load tags for a bounded document page without one query per document."""
    documents = list(documents)
    if not documents:
        return []
    tags = defaultdict(list)
    for document_id, tag_id in db.execute(select(DocumentTag.document_id, DocumentTag.tag_id).where(
        DocumentTag.document_id.in_([doc.id for doc in documents])).order_by(DocumentTag.tag_id)):
        tags[document_id].append(tag_id)
    return [{**snapshot(doc), "tag_ids": tags[doc.id]} for doc in documents]


def audit(db, actor, kb_id, action, entity_id, before, after, **kwargs):
    db.add(AuditLog(actor_id=actor.id, kb_id=kb_id, action=action, entity_id=entity_id, before=before, after=after, **kwargs))
