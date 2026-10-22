import hashlib
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import AppError
from app.db.models import (
    ClassificationSuggestion,
    Document,
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
    folder_name_conflict,
    get_document,
    lock_kb_namespace,
    normalized_name,
    snapshot,
    update_document,
    update_folder,
    valid_name,
    validate_folder,
    version_check,
)
from app.services.permissions import assert_can_edit_kb, assert_can_manage_kb, assert_can_read_kb, get_actor

router = APIRouter(prefix="/api")


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
    kb = KnowledgeBase(name=valid_name(body.name), description=body.description, owner_id=actor.id)
    db.add(kb)
    db.flush()
    db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
    return kb


@router.get("/knowledge-bases/{kb_id}", response_model=KnowledgeBaseOut)
def read_kb(kb_id: str, db: Session = Depends(get_db, scope="function")):
    return assert_can_read_kb(db, get_actor(db), kb_id)


@router.patch("/knowledge-bases/{kb_id}", response_model=KnowledgeBaseOut)
def patch_kb(kb_id: str, body: KBUpdate, db: Session = Depends(get_db, scope="function")):
    kb = assert_can_manage_kb(db, get_actor(db), kb_id)
    db.refresh(kb, with_for_update=True)
    version_check(kb, body.version)
    if body.name is not None:
        kb.name = valid_name(body.name)
    if body.description is not None:
        kb.description = body.description
    kb.version += 1
    return kb


@router.delete("/knowledge-bases/{kb_id}")
def delete_kb(kb_id: str, db: Session = Depends(get_db, scope="function")):
    kb = assert_can_manage_kb(db, get_actor(db), kb_id)
    db.refresh(kb, with_for_update=True)
    kb.deleted_at, kb.version = utcnow(), kb.version + 1
    return {"status": "trashed"}


@router.post("/knowledge-bases/{kb_id}/restore")
def restore_kb(kb_id: str, db: Session = Depends(get_db, scope="function")):
    kb = assert_can_manage_kb(db, get_actor(db), kb_id, include_deleted=True)
    db.refresh(kb, with_for_update=True)
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
    db.refresh(folder)
    subtree = descendants(db, folder.kb_id, [folder.id])
    # Preserve each resource for explicit restore; content is excluded from search immediately.
    for doc in db.scalars(select(Document).where(Document.folder_id.in_(subtree), Document.deleted_at.is_(None))):
        update_document(db, actor, doc.id, {"deleted_at": True})
    for item in db.scalars(select(Folder).where(Folder.id.in_(subtree))):
        item.deleted_at, item.version = utcnow(), item.version + 1
    return {"status": "trashed", "folders": len(subtree)}


@router.post("/folders/{folder_id}/restore")
def restore_folder(folder_id: str, db: Session = Depends(get_db, scope="function")):
    folder = db.get(Folder, folder_id)
    if not folder:
        raise AppError("not_found", "文件夹不存在", 404)
    lock_kb_namespace(db, get_actor(db), folder.kb_id)
    db.refresh(folder, with_for_update=True)
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
    db.refresh(tag, with_for_update=True)
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
    db.refresh(tag, with_for_update=True)
    # Tag changes invalidate pending plans and undo snapshots of affected documents.
    ids = list(db.scalars(select(DocumentTag.document_id).where(DocumentTag.tag_id == tag_id)))
    for doc in db.scalars(select(Document).where(Document.id.in_(ids)).with_for_update()):
        doc.version += 1
    db.execute(delete(DocumentTag).where(DocumentTag.tag_id == tag_id))
    db.delete(tag)
    return {"status": "deleted"}


@router.get("/knowledge-bases/{kb_id}/documents", response_model=DocumentPage)
def documents(kb_id: str, folder_id: str | None = None, include_descendants: bool = False, tag_ids: str = "", ext: str | None = None, status: str | None = None, trash: bool = False, sort: str = "date", page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200), db: Session = Depends(get_db, scope="function")):
    assert_can_read_kb(db, get_actor(db), kb_id)
    stmt = select(Document).where(Document.kb_id == kb_id, Document.deleted_at.is_not(None) if trash else Document.deleted_at.is_(None))
    if folder_id == "root":
        stmt = stmt.where(Document.folder_id.is_(None))
    elif folder_id:
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
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    order = {"name": Document.display_name, "type": Document.ext, "date": Document.created_at.desc()}.get(sort, Document.created_at.desc())
    return {"items": [document_snapshot(db, d) for d in db.scalars(stmt.order_by(order, Document.id).offset((page - 1) * page_size).limit(page_size))], "total": total, "page": page, "page_size": page_size}


@router.post("/knowledge-bases/{kb_id}/uploads")
def upload(kb_id: str, files: list[UploadFile] = File(...), folder_id: str | None = Form(None), duplicate_policy: str = Form("skip"), db: Session = Depends(get_db, scope="function")):
    from app.ingestion.parsers import validate_content

    settings, actor = get_settings(), get_actor(db)
    lock_kb_namespace(db, actor, kb_id)
    validate_folder(db, kb_id, folder_id or None)
    if len(files) > settings.max_upload_batch_files or duplicate_policy not in {"skip", "copy"}:
        raise AppError("invalid_batch", "批量数量超限或重复文件策略不合法")
    items, jobs, total = [], [], 0
    for file in files:
        name = file.filename or ""
        try:
            if any(c in name for c in ["/", "\\", "\x00"]) or name in {".", ".."}:
                raise AppError("invalid_filename", "文件名包含危险路径")
            valid_name(name, 255)
            ext = Path(name).suffix.lower().lstrip(".")
            if ext not in {"pdf", "docx", "md", "txt"}:
                raise AppError("unsupported_type", "仅支持 PDF、DOCX、MD、TXT")
            allowed_mime = {
                "pdf": {"application/pdf"},
                "docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip"},
                "md": {"text/markdown", "text/plain", "text/x-markdown"},
                "txt": {"text/plain"},
            }
            mime = (file.content_type or "application/octet-stream").split(";", 1)[0].strip().lower()
            if mime not in allowed_mime[ext] | {"application/octet-stream"}:
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
            doc_id = new_id()
            key = f"{kb_id}/{doc_id}/original"
            dest = settings.upload_root.resolve() / key
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            doc = Document(id=doc_id, kb_id=kb_id, folder_id=folder_id or None, owner_id=actor.id, display_name=name, original_filename=name, mime_type={"pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "md": "text/markdown", "txt": "text/plain"}[ext], ext=ext, sha256=digest, size_bytes=len(data), storage_key=key)
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
    assert_can_edit_kb(db, actor, body.kb_id)
    for doc_id in body.document_ids:
        doc = get_document(db, actor, doc_id, include_deleted=True)
        if doc.kb_id != body.kb_id:
            raise AppError("cross_kb", "不支持跨知识库批量操作")
    data = {"move": {"folder_id": body.folder_id}, "tags": {"tag_ids": body.tag_ids, "tag_mode": body.tag_mode}, "trash": {"deleted_at": True}, "restore": {"deleted_at": None}}[body.action]
    return {"items": [document_snapshot(db, update_document(db, actor, doc_id, data)) for doc_id in dict.fromkeys(body.document_ids)]}


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
    actor = get_actor(db)
    doc = get_document(db, actor, doc_id)
    assert_can_edit_kb(db, actor, doc.kb_id)
    item = db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == doc_id).with_for_update())
    if not item or item.status != "pending":
        raise AppError("not_pending", "没有待处理的建议", 409)
    version_check(doc, item.document_version)
    if body.action == "reject":
        item.status = "rejected"
        return item
    from app.ingestion.enrichment import ClassificationResult
    payload = ClassificationResult.model_validate(body.payload or item.payload).model_dump()
    folder_id = payload.get("existing_folder_id")
    validate_folder(db, doc.kb_id, folder_id)
    if not folder_id and payload.get("proposed_folder_path"):
        parent = None
        for name in payload["proposed_folder_path"].split("/"):
            if not name.strip():
                continue
            existing = db.scalar(select(Folder).where(Folder.kb_id == doc.kb_id, Folder.parent_id == parent, Folder.name == name.strip(), Folder.deleted_at.is_(None)))
            parent = existing.id if existing else create_folder(db, actor, doc.kb_id, {"name": name, "parent_id": parent}).id
        folder_id = parent
    tag_ids = list(payload.get("existing_tag_ids", []))
    for name in payload.get("new_tag_names", []):
        existing = next((t for t in db.scalars(select(Tag).where(Tag.kb_id == doc.kb_id)) if normalized_name(name) in {t.normalized_name, *map(normalized_name, t.aliases)}), None)
        if existing:
            tag_ids.append(existing.id)
        else:
            tag_ids.append(add_tag(doc.kb_id, TagCreate(name=name), db).id)
    update_document(db, actor, doc.id, {"folder_id": folder_id, "tag_ids": tag_ids})
    item.payload, item.status = payload, "applied"
    return item
