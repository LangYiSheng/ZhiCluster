import hashlib
import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import AppError
from app.db.models import (
    ClassificationSuggestion,
    Document,
    DocumentChunk,
    DocumentSection,
    DocumentTag,
    Folder,
    IngestionJob,
    KnowledgeBase,
    KnowledgeBaseMember,
    Tag,
    new_id,
    utcnow,
)
from app.db.session import get_db
from app.schemas.requests import (
    Batch,
    DocumentUpdate,
    FolderCreate,
    FolderUpdate,
    KBCreate,
    KBUpdate,
    SuggestionAction,
    TagCreate,
    TagUpdate,
)
from app.schemas.responses import DocumentOut, DocumentPage, FolderOut, KnowledgeBaseOut, SectionOut, TagOut
from app.services.library import (
    audit,
    create_folder,
    descendants,
    document_snapshot,
    document_snapshots,
    folder_name_conflict,
    get_document,
    lock_kb_namespace,
    lock_metadata_entity,
    normalized_name,
    snapshot,
    update_document,
    update_documents,
    update_folder,
    valid_name,
    validate_folder,
    version_check,
)
from app.services.permissions import assert_can_manage_kb, assert_can_read_kb, get_actor

router = APIRouter(prefix="/api")


@router.get("/settings/file-formats")
def file_formats(db: Session = Depends(get_db, scope="function")):
    from app.ingestion.format_registry import get_registry

    get_actor(db)
    settings = get_settings()
    return {"formats": [spec.public() for spec in get_registry().values()], "limits": {
        "max_file_size_bytes": settings.max_upload_size_mb * 1024 * 1024,
        "max_batch_size_bytes": settings.max_upload_batch_mb * 1024 * 1024,
        "max_batch_files": settings.max_upload_batch_files}}


@router.get("/knowledge-bases", response_model=list[KnowledgeBaseOut])
def knowledge_bases(include_deleted: bool = False, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    stmt = select(KnowledgeBase).join(KnowledgeBaseMember, KnowledgeBaseMember.kb_id == KnowledgeBase.id).where(KnowledgeBaseMember.user_id == actor.id)
    if not include_deleted:
        stmt = stmt.where(KnowledgeBase.deleted_at.is_(None))
    return list(db.scalars(stmt.order_by(KnowledgeBase.created_at)))


@router.post("/knowledge-bases", status_code=201, response_model=KnowledgeBaseOut)
def create_kb(body: KBCreate, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    if body.embedding_model is not None:
        body.embedding_model = valid_name(body.embedding_model, 512)
    kb = KnowledgeBase(**{**body.model_dump(), "name": valid_name(body.name)}, owner_id=actor.id)
    db.add(kb)
    db.flush()
    db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
    return kb


@router.get("/knowledge-bases/{kb_id}", response_model=KnowledgeBaseOut)
def read_kb(kb_id: str, db: Session = Depends(get_db, scope="function")):
    return assert_can_read_kb(db, get_actor(db), kb_id)


def _managed_kb_for_update(db, actor, kb_id, *, include_deleted=False):
    assert_can_manage_kb(db, actor, kb_id, include_deleted=include_deleted)
    kb = lock_metadata_entity(db, KnowledgeBase, kb_id, None, "知识库")
    # Waiting for this row lock can outlive a soft deletion or access change.
    assert_can_manage_kb(db, actor, kb_id, include_deleted=include_deleted)
    return kb


@router.patch("/knowledge-bases/{kb_id}", response_model=KnowledgeBaseOut)
def patch_kb(kb_id: str, body: KBUpdate, db: Session = Depends(get_db, scope="function")):
    kb = _managed_kb_for_update(db, get_actor(db), kb_id)
    version_check(kb, body.version)
    if body.name is not None:
        kb.name = valid_name(body.name)
    if body.description is not None:
        kb.description = body.description
    for field in ("icon", "color", "embedding_model", "embedding_dimension"):
        if field in body.model_fields_set:
            value = getattr(body, field)
            if field in {"icon", "color"} and value is None:
                raise AppError("invalid_metadata", "图标和颜色不能为空", 422)
            if field == "embedding_model" and value is not None:
                value = valid_name(value, 512)
            setattr(kb, field, value)
    kb.version += 1
    return kb


@router.delete("/knowledge-bases/{kb_id}")
def delete_kb(kb_id: str, db: Session = Depends(get_db, scope="function")):
    kb = _managed_kb_for_update(db, get_actor(db), kb_id)
    kb.deleted_at, kb.version = utcnow(), kb.version + 1
    return {"status": "trashed"}


@router.post("/knowledge-bases/{kb_id}/restore")
def restore_kb(kb_id: str, db: Session = Depends(get_db, scope="function")):
    kb = _managed_kb_for_update(db, get_actor(db), kb_id, include_deleted=True)
    kb.deleted_at, kb.version = None, kb.version + 1
    return kb


@router.get("/knowledge-bases/{kb_id}/folders", response_model=list[FolderOut])
def folders(kb_id: str, include_deleted: bool = False, db: Session = Depends(get_db, scope="function")):
    assert_can_read_kb(db, get_actor(db), kb_id)
    stmt = select(Folder).where(Folder.kb_id == kb_id)
    if not include_deleted:
        stmt = stmt.where(Folder.deleted_at.is_(None))
    return list(db.scalars(stmt.order_by(Folder.sort_order, Folder.name)))


@router.post("/knowledge-bases/{kb_id}/folders", status_code=201, response_model=FolderOut)
def add_folder(kb_id: str, body: FolderCreate, db: Session = Depends(get_db, scope="function")):
    return create_folder(db, get_actor(db), kb_id, body.model_dump())


@router.patch("/folders/{folder_id}", response_model=FolderOut)
def patch_folder(folder_id: str, body: FolderUpdate, db: Session = Depends(get_db, scope="function")):
    return update_folder(db, get_actor(db), folder_id, body.model_dump(exclude_unset=True))


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: str, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    folder = db.get(Folder, folder_id)
    if not folder:
        raise AppError("not_found", "文件夹不存在", 404)
    lock_kb_namespace(db, actor, folder.kb_id)
    folder = lock_metadata_entity(db, Folder, folder_id, folder.kb_id, "文件夹")
    subtree = descendants(db, folder.kb_id, [folder.id])
    # Preserve each resource for explicit restore; content is excluded from search immediately.
    # The namespace is already locked. Lock and snapshot the batch once rather
    # than re-entering update_document (and querying tags twice) for each file.
    docs = list(db.scalars(select(Document).where(
        Document.kb_id == folder.kb_id, Document.folder_id.in_(subtree), Document.deleted_at.is_(None),
    ).order_by(Document.id).with_for_update().execution_options(populate_existing=True)))
    before = document_snapshots(db, docs)
    deleted_at = utcnow()
    for doc in docs:
        doc.deleted_at, doc.version = deleted_at, doc.version + 1
    db.flush()
    for doc, previous in zip(docs, before, strict=True):
        after = {**snapshot(doc), "tag_ids": previous["tag_ids"]}
        audit(db, actor, doc.kb_id, "update_document", doc.id, previous, after)
    for item in db.scalars(select(Folder).where(Folder.id.in_(subtree))):
        item.deleted_at, item.version = utcnow(), item.version + 1
    return {"status": "trashed", "folders": len(subtree)}


@router.post("/folders/{folder_id}/restore")
def restore_folder(folder_id: str, db: Session = Depends(get_db, scope="function")):
    folder = db.get(Folder, folder_id)
    if not folder:
        raise AppError("not_found", "文件夹不存在", 404)
    lock_kb_namespace(db, get_actor(db), folder.kb_id)
    folder = lock_metadata_entity(db, Folder, folder_id, folder.kb_id, "文件夹")
    validate_folder(db, folder.kb_id, folder.parent_id)
    folder_name_conflict(db, folder.kb_id, folder.parent_id, folder.name, folder.id)
    folder.deleted_at, folder.version = None, folder.version + 1
    return folder


@router.get("/knowledge-bases/{kb_id}/tags", response_model=list[TagOut])
def tags(kb_id: str, db: Session = Depends(get_db, scope="function")):
    assert_can_read_kb(db, get_actor(db), kb_id)
    return list(db.scalars(select(Tag).where(Tag.kb_id == kb_id).order_by(Tag.name)))


def validate_tag_unique(db, kb_id, name, aliases, exclude=None):
    keys = {normalized_name(n) for n in [name, *aliases]}
    if "" in keys:
        raise AppError("invalid_name", "标签别名不能为空")
    for tag in db.scalars(select(Tag).where(Tag.kb_id == kb_id)):
        if tag.id != exclude and keys & {tag.normalized_name, *[normalized_name(a) for a in tag.aliases]}:
            raise AppError("duplicate_tag", f"标签或别名与「{tag.name}」重复", 409, {"tag_id": tag.id})


@router.post("/knowledge-bases/{kb_id}/tags", status_code=201, response_model=TagOut)
def add_tag(kb_id: str, body: TagCreate, db: Session = Depends(get_db, scope="function")):
    lock_kb_namespace(db, get_actor(db), kb_id)
    name = valid_name(body.name, 100)
    validate_tag_unique(db, kb_id, name, body.aliases)
    tag = Tag(kb_id=kb_id, name=name, normalized_name=normalized_name(name), color=body.color, aliases=body.aliases)
    db.add(tag)
    db.flush()
    return tag


@router.patch("/tags/{tag_id}", response_model=TagOut)
def patch_tag(tag_id: str, body: TagUpdate, db: Session = Depends(get_db, scope="function")):
    tag = db.get(Tag, tag_id)
    if not tag:
        raise AppError("not_found", "标签不存在", 404)
    lock_kb_namespace(db, get_actor(db), tag.kb_id)
    tag = lock_metadata_entity(db, Tag, tag_id, tag.kb_id, "标签")
    version_check(tag, body.version)
    name = valid_name(body.name or tag.name, 100)
    aliases = tag.aliases if body.aliases is None else body.aliases
    validate_tag_unique(db, tag.kb_id, name, aliases, tag.id)
    tag.name, tag.normalized_name, tag.aliases = name, normalized_name(name), aliases
    if body.color:
        tag.color = body.color
    tag.version += 1
    return tag


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: str, db: Session = Depends(get_db, scope="function")):
    tag = db.get(Tag, tag_id)
    if not tag:
        raise AppError("not_found", "标签不存在", 404)
    lock_kb_namespace(db, get_actor(db), tag.kb_id)
    tag = lock_metadata_entity(db, Tag, tag_id, tag.kb_id, "标签")
    # Tag changes invalidate pending plans and undo snapshots of affected documents.
    ids = list(db.scalars(select(DocumentTag.document_id).where(DocumentTag.tag_id == tag_id)))
    for doc in db.scalars(select(Document).where(Document.id.in_(ids)).with_for_update()):
        doc.version += 1
    db.execute(delete(DocumentTag).where(DocumentTag.tag_id == tag_id))
    db.delete(tag)
    return {"status": "deleted"}


@router.get("/knowledge-bases/{kb_id}/documents", response_model=DocumentPage)
def documents(kb_id: str, folder_id: str | None = None, include_descendants: bool = False, tag_ids: str = "", ext: str | None = None, status: str | None = None, trash: bool = False, sort: str = "date", q: str = Query("", max_length=2000), page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200), db: Session = Depends(get_db, scope="function")):
    assert_can_read_kb(db, get_actor(db), kb_id)
    stmt = select(Document).where(Document.kb_id == kb_id, Document.deleted_at.is_not(None) if trash else Document.deleted_at.is_(None))
    if folder_id == "root" and not include_descendants:
        stmt = stmt.where(Document.folder_id.is_(None))
    elif folder_id and folder_id != "root":
        ids = descendants(db, kb_id, [folder_id]) if include_descendants else {validate_folder(db, kb_id, folder_id).id}
        stmt = stmt.where(Document.folder_id.in_(ids))
    for tag_id in filter(None, tag_ids.split(",")):
        tag = db.get(Tag, tag_id)
        if not tag or tag.kb_id != kb_id:
            raise AppError("invalid_tags", "标签不属于当前知识库")
        stmt = stmt.where(Document.id.in_(select(DocumentTag.document_id).where(DocumentTag.tag_id == tag_id)))
    if ext:
        stmt = stmt.where(Document.ext == ext.lstrip("."))
    if status:
        stmt = stmt.where(Document.parse_status == status)
    if q.strip():
        term = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(or_(Document.display_name.ilike(term, escape="\\"),
            Document.id.in_(select(DocumentChunk.document_id).where(DocumentChunk.kb_id == kb_id,
                DocumentChunk.content.ilike(term, escape="\\")))))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    order = {"name": Document.display_name, "type": Document.ext, "date": Document.created_at.desc(),
        "created": Document.created_at.desc(), "updated": Document.updated_at.desc(), "size": Document.size_bytes.desc()}.get(sort, Document.created_at.desc())
    items = db.scalars(stmt.order_by(order, Document.id).offset((page - 1) * page_size).limit(page_size))
    return {"items": document_snapshots(db, items), "total": total, "page": page, "page_size": page_size}


@router.post("/knowledge-bases/{kb_id}/uploads")
def upload(kb_id: str, files: list[UploadFile] = File(...), folder_id: str | None = Form(None), duplicate_policy: str = Form("skip"), relative_paths: str | None = Form(None), db: Session = Depends(get_db, scope="function")):
    from app.ingestion.format_registry import get_format
    from app.ingestion.parsers import validate_content

    settings, actor = get_settings(), get_actor(db)
    lock_kb_namespace(db, actor, kb_id)
    validate_folder(db, kb_id, folder_id or None)
    if len(files) > settings.max_upload_batch_files or duplicate_policy not in {"skip", "copy"}:
        raise AppError("invalid_batch", "批量数量超限或重复文件策略不合法")
    paths = None
    if relative_paths is not None:
        try:
            paths = json.loads(relative_paths)
            if not isinstance(paths, list) or len(paths) != len(files) or any(not isinstance(path, str) for path in paths):
                raise ValueError()
            for path, file in zip(paths, files, strict=True):
                parts = path.split("/")
                if (len(path) > 2048 or len(parts) > 32 or "\\" in path or ":" in path
                        or any(part in {"", ".", ".."} for part in parts) or parts[-1] != file.filename):
                    raise ValueError()
                for part in parts:
                    valid_name(part, 255 if part == parts[-1] else 160)
            if len(set(paths)) != len(paths):
                raise ValueError()
        except (ValueError, TypeError, AppError) as error:
            raise AppError("invalid_relative_paths", "文件夹路径不合法，需与文件一一对应且不能包含绝对路径或上级目录", 422) from error
    items, jobs, total = [], [], 0
    folder_cache = {}
    for index, file in enumerate(files):
        name = file.filename or ""
        try:
            if any(c in name for c in ["/", "\\", "\x00"]) or name in {".", ".."}:
                raise AppError("invalid_filename", "文件名包含危险路径")
            valid_name(name, 255)
            ext = Path(name).suffix.lower().lstrip(".")
            spec = get_format(ext)
            mime = (file.content_type or "application/octet-stream").split(";", 1)[0].strip().lower()
            if mime not in {spec.mime_type, *spec.accepted_mimes, "application/octet-stream"}:
                raise AppError("invalid_content_type", "文件内容类型与扩展名不匹配")
            # A bounded read prevents unbounded memory use, including oversized batches.
            limit = settings.max_upload_size_mb * 1024 * 1024
            data = file.file.read(limit + 1)
            total += len(data)
            if len(data) > limit or total > settings.max_upload_batch_mb * 1024 * 1024:
                raise AppError("upload_too_large", "单文件或本批总量超过上传限制", 413)
            validate_content(data, ext)
            digest = hashlib.sha256(data).hexdigest()
            existing = db.scalar(select(Document).where(Document.kb_id == kb_id, Document.sha256 == digest, Document.deleted_at.is_(None)))
            if existing and duplicate_policy == "skip":
                items.append({"status": "duplicate", "filename": name, "document": document_snapshot(db, existing), "message": "同库已有相同文件；选择保留副本可再次上传"})
                continue
            target_folder_id = folder_id or None
            if paths:
                for part in paths[index].split("/")[:-1]:
                    cache_key = (target_folder_id, normalized_name(part))
                    if cache_key not in folder_cache:
                        siblings = db.scalars(select(Folder).where(Folder.kb_id == kb_id,
                            Folder.parent_id == target_folder_id, Folder.deleted_at.is_(None)))
                        target = next((folder for folder in siblings if normalized_name(folder.name) == normalized_name(part)), None)
                        if target is None:
                            target = create_folder(db, actor, kb_id, {"parent_id": target_folder_id, "name": part})
                        folder_cache[cache_key] = target.id
                    target_folder_id = folder_cache[cache_key]
            doc_id = new_id()
            key = f"{kb_id}/{doc_id}/original"
            dest = settings.upload_root.resolve() / key
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            doc = Document(id=doc_id, kb_id=kb_id, folder_id=target_folder_id, owner_id=actor.id, display_name=name, original_filename=name, mime_type=spec.mime_type, ext=ext, sha256=digest, size_bytes=len(data), storage_key=key)
            db.add(doc)
            db.flush()
            job = IngestionJob(document_id=doc_id, kb_id=kb_id)
            db.add(job)
            db.flush()
            items.append({"status": "queued", "filename": name, "document": document_snapshot(db, doc)})
            jobs.append(snapshot(job))
            audit(db, actor, kb_id, "upload", doc.id, {}, {"filename": name, "sha256": digest})
        except (AppError, ValueError) as exc:
            items.append({"status": "error", "filename": name, "message": str(exc)})
        finally:
            file.file.close()
    return {"items": items, "jobs": jobs}


@router.post("/documents/batch")
def batch(body: Batch, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    data = {"move": {"folder_id": body.folder_id}, "tags": {"tag_ids": body.tag_ids, "tag_mode": body.tag_mode}, "trash": {"deleted_at": True}, "restore": {"deleted_at": None}}[body.action]
    return {"items": update_documents(db, actor, body.kb_id, body.document_ids, data)}


@router.get("/documents/{doc_id}", response_model=DocumentOut)
def document(doc_id: str, db: Session = Depends(get_db, scope="function")):
    return document_snapshot(db, get_document(db, get_actor(db), doc_id))


@router.patch("/documents/{doc_id}", response_model=DocumentOut)
def patch_document(doc_id: str, body: DocumentUpdate, db: Session = Depends(get_db, scope="function")):
    return document_snapshot(db, update_document(db, get_actor(db), doc_id, body.model_dump(exclude_unset=True)))


@router.delete("/documents/{doc_id}")
def delete_document(doc_id: str, db: Session = Depends(get_db, scope="function")):
    return document_snapshot(db, update_document(db, get_actor(db), doc_id, {"deleted_at": True}))


@router.post("/documents/{doc_id}/restore")
def restore_document(doc_id: str, db: Session = Depends(get_db, scope="function")):
    return document_snapshot(db, update_document(db, get_actor(db), doc_id, {"deleted_at": None}))


@router.get("/documents/{doc_id}/sections", response_model=list[SectionOut])
def document_sections(doc_id: str, db: Session = Depends(get_db, scope="function")):
    get_document(db, get_actor(db), doc_id)
    return list(db.scalars(select(DocumentSection).where(DocumentSection.document_id == doc_id).order_by(DocumentSection.order)))


@router.get("/documents/{doc_id}/content")
def content(doc_id: str, db: Session = Depends(get_db, scope="function")):
    sections = document_sections(doc_id, db)
    return {"text": "\n\n".join(s.plain_text for s in sections), "sections": sections}


@router.get("/documents/{doc_id}/download")
def download(doc_id: str, inline: bool = False, db: Session = Depends(get_db, scope="function")):
    doc = get_document(db, get_actor(db), doc_id)
    root = get_settings().upload_root.resolve()
    path = (root / doc.storage_key).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise AppError("file_missing", "原文件不存在", 404)
    return FileResponse(path, media_type=doc.mime_type, filename=doc.original_filename, content_disposition_type="inline" if inline and doc.ext == "pdf" else "attachment", headers={"X-Content-Type-Options": "nosniff"})


@router.get("/documents/{doc_id}/suggestion")
def suggestion(doc_id: str, db: Session = Depends(get_db, scope="function")):
    get_document(db, get_actor(db), doc_id)
    return db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == doc_id))


@router.post("/documents/{doc_id}/suggestion")
def apply_suggestion(doc_id: str, body: SuggestionAction, db: Session = Depends(get_db, scope="function")):
    from app.schemas.review import SuggestionDecision
    from app.services.review import decide_suggestion

    actor = get_actor(db)
    doc = get_document(db, actor, doc_id)
    item = db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == doc_id))
    if not item:
        raise AppError("not_pending", "没有待处理的建议", 409)
    result = decide_suggestion(db, actor, item.id, SuggestionDecision(action=body.action,
        document_version=doc.version, payload=body.payload))
    return {**snapshot(item), "run_id": result.get("run_id"), "undo_available": result.get("undo_available", False)}
