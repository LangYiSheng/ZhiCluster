"""Current, authorized source metadata for citation snapshots and event replay."""

from sqlalchemy import select

from app.core.errors import AppError
from app.db.models import Document, DocumentChunk, Folder, KnowledgeBase, KnowledgeBaseMember
from app.services.library import get_document

_CITATION_FIELDS = {
    "id", "created_at", "updated_at", "version", "message_id", "document_id", "chunk_id",
    "ordinal", "anchors", "snippet", "candidate",
}


def visible_citation(db, actor, data, *, kb_ids=None):
    # Old event payloads are not an authority for names, format, KB or access.
    result = {key: value for key, value in data.items() if key in _CITATION_FIELDS}
    try:
        doc = db.get(Document, data.get("document_id"), populate_existing=True) if data.get("document_id") else None
        if doc is None or (kb_ids is not None and doc.kb_id not in kb_ids):
            raise AppError("not_found", "来源不可用", 404)
        kb = db.get(KnowledgeBase, doc.kb_id, populate_existing=True)
        db.scalar(select(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == doc.kb_id,
            KnowledgeBaseMember.user_id == actor.id).execution_options(populate_existing=True))
        if doc.folder_id:
            db.get(Folder, doc.folder_id, populate_existing=True)
        doc = get_document(db, actor, doc.id)
        if data.get("chunk_id"):
            chunk = db.get(DocumentChunk, data["chunk_id"], populate_existing=True)
            if chunk is None or chunk.document_id != doc.id or chunk.kb_id != doc.kb_id:
                raise AppError("not_found", "引用片段已不可用", 404)
        result.update(document_name=doc.display_name, ext=doc.ext, kb_id=doc.kb_id, kb_name=kb.name, available=True)
    except AppError:
        result.update(document_name="来源不可用", snippet="来源已删除或不可访问", available=False,
            ext=None, kb_id=None, kb_name=None, anchors={})
    return result
