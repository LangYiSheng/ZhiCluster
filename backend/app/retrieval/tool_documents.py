"""Bounded document discovery and reading through the same immutable chat scope."""

import json
from copy import deepcopy

from sqlalchemy import func, or_, select

from app.core.errors import AppError
from app.db.models import Document, DocumentChunk, DocumentSection, KnowledgeBase
from app.retrieval.search import scoped_query
from app.retrieval.terms import escape_like
from app.retrieval.tool_scope import scope_key

MAX_DOCUMENT_ITEMS = 20
MAX_OUTLINE_ITEMS = 20
MAX_READ_CHUNKS = 4
MAX_DOCUMENT_RESPONSE_CHARS = 5000
MAX_READ_RESPONSE_CHARS = 10000


class ScopedDocuments:
    def __init__(self, view):
        self.view = view
        self.db, self.actor, self.fixed = view.db, view.actor, view.fixed
        self.known = {}

    def remember(self, document_id, scopes):
        saved = self.known.setdefault(document_id, {})
        for scope in scopes:
            saved[scope_key(scope)] = deepcopy(scope)

    def remember_hits(self, hits):
        for hit in hits:
            self.remember(hit["document_id"], hit.get("_search_scopes") or [self.fixed])

    def _chunks(self, document_id):
        self.view.refresh()
        origins = self.known.get(document_id)
        if not origins:
            raise AppError("invalid_tool_scope", "请先从当前范围的搜索或文档列表取得可用文档ID", 400)
        base, _ = scoped_query(self.db, self.actor, self.fixed)
        constraints, available = [], []
        for origin in origins.values():
            try:
                narrowed, _ = scoped_query(self.db, self.actor, origin)
            except AppError as error:
                if error.code in {"invalid_folder", "invalid_tags"}:
                    continue
                raise
            ids = narrowed.with_only_columns(DocumentChunk.id).subquery()
            constraints.append(DocumentChunk.id.in_(select(ids.c.id)))
            available.append(origin)
        if not constraints:
            raise AppError("invalid_tool_scope", "资料已不在先前查阅的可用范围中", 400)
        stmt = base.where(Document.id == document_id, or_(*constraints))
        if self.db.scalar(stmt.with_only_columns(DocumentChunk.id).limit(1)) is None:
            raise AppError("invalid_tool_scope", "资料已不可用或已移出先前查阅范围", 400)
        return stmt, available

    def list(self, *, fields=None, query="", offset=0, limit=10):
        actual = self.view.narrow(fields or {})
        stmt, _ = scoped_query(self.db, self.actor, actual)
        if query.strip():
            stmt = stmt.where(Document.display_name.ilike(f"%{escape_like(query.strip())}%", escape="\\"))
        ids = stmt.with_only_columns(Document.id).distinct().subquery()
        total = self.db.scalar(select(func.count()).select_from(ids)) or 0
        docs = list(self.db.scalars(select(Document).where(Document.id.in_(select(ids.c.id)))
            .order_by(Document.display_name, Document.id).offset(offset).limit(min(limit, MAX_DOCUMENT_ITEMS))
            .execution_options(populate_existing=True)))
        items = []
        for doc in docs:
            item = {"document_id": doc.id, "document_name": doc.display_name[:255], "kb_id": doc.kb_id,
                "ext": doc.ext, "folder_id": doc.folder_id}
            if len(json.dumps(items + [item], ensure_ascii=False)) > MAX_DOCUMENT_RESPONSE_CHARS - 400:
                break
            items.append(item)
            self.remember(doc.id, [actual])
        reached = offset + len(items)
        return {"items": items, "total": total, "next_offset": reached if reached < total else None}, actual

    def outline(self, document_id, *, offset=0, limit=20):
        chunks, origins = self._chunks(document_id)
        ids = chunks.with_only_columns(DocumentChunk.section_id).distinct().subquery()
        stmt = select(DocumentSection).where(DocumentSection.document_id == document_id,
            DocumentSection.id.in_(select(ids.c.section_id))).order_by(DocumentSection.order, DocumentSection.id)
        sections = list(self.db.scalars(stmt.offset(offset).limit(min(limit, MAX_OUTLINE_ITEMS))))
        total = self.db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
        items = []
        for section in sections:
            item = {"section_id": section.id, "heading": section.heading[:240], "level": section.level,
                "order": section.order, "anchors": section.anchors}
            if len(json.dumps(items + [item], ensure_ascii=False)) > MAX_DOCUMENT_RESPONSE_CHARS - 500:
                break
            items.append(item)
        doc = self.db.get(Document, document_id, populate_existing=True)
        reached = offset + len(items)
        return {"document_id": doc.id, "document_name": doc.display_name[:255], "items": items,
            "total": total, "next_offset": reached if reached < total else None}, origins

    def read(self, document_id, *, section_ids=None, page=None, offset=0, limit=3):
        stmt, origins = self._chunks(document_id)
        if section_ids:
            visible = set(self.db.scalars(stmt.with_only_columns(DocumentChunk.section_id).distinct()))
            if not set(section_ids).issubset(visible):
                raise AppError("invalid_tool_scope", "所选章节不在当前可用资料中", 400)
            stmt = stmt.where(DocumentChunk.section_id.in_(section_ids))
        # Fetch a bounded slice. PDF page filtering is SQL-side on both SQLite and PostgreSQL.
        if page is not None:
            start = DocumentChunk.anchors["page_start"].as_integer()
            end = DocumentChunk.anchors["page_end"].as_integer()
            stmt = stmt.where(start <= page, func.coalesce(end, start) >= page)
        rows = list(self.db.execute(stmt.order_by(DocumentChunk.chunk_index, DocumentChunk.id)
            .offset(offset).limit(min(limit, MAX_READ_CHUNKS) + 1).execution_options(populate_existing=True)))
        items, hits, used = [], [], 0
        for chunk, doc in rows[:min(limit, MAX_READ_CHUNKS)]:
            content = chunk.content[:6000]
            item = {"document_id": doc.id, "document_name": doc.display_name[:255], "chunk_id": chunk.id,
                "section_id": chunk.section_id, "chunk_index": chunk.chunk_index, "anchors": chunk.anchors,
                "content": content, "truncated": len(content) < len(chunk.content)}
            size = len(json.dumps(item, ensure_ascii=False))
            if used + size > MAX_READ_RESPONSE_CHARS - 500:
                break
            used += size
            kb = self.db.get(KnowledgeBase, doc.kb_id)
            items.append(item)
            hits.append({"document_id": doc.id, "document_name": doc.display_name, "chunk_id": chunk.id,
                "section_id": chunk.section_id, "content": chunk.content, "snippet": content[:400],
                "anchors": chunk.anchors, "kb_id": doc.kb_id, "kb_name": kb.name, "ext": doc.ext,
                "_search_scopes": deepcopy(origins)})
        reached = offset + len(items)
        return {"document_id": document_id, "items": items,
            "next_offset": reached if len(rows) > len(items) else None}, hits, origins
