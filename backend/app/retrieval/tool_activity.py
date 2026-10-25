"""Revalidate persisted public tool activity before snapshots and SSE replay."""

from copy import deepcopy

from sqlalchemy import or_, select

from app.core.errors import AppError
from app.db.models import Document, DocumentChunk
from app.retrieval.search import scoped_query
from app.retrieval.tool_scope import ReadOnlyScope
from app.services.citations import visible_citation


def visible_execution(db, actor, scope, steps):
    if not isinstance(steps, list):
        return steps
    result = []
    for original in steps:
        if not isinstance(original, dict):
            continue
        step = {key: deepcopy(value) for key, value in original.items() if not key.startswith("_")}
        if step.get("stage") != "tool_activity":
            result.append(step)
            continue
        try:
            ReadOnlyScope(db, actor, scope).refresh()
            if original.get("_activity_scope"):
                scoped_query(db, actor, original["_activity_scope"])
                step["scope_label"] = ReadOnlyScope(db, actor, scope).label(original["_activity_scope"])
            if not original.get("document_id"):
                result.append(step)
                continue
            base, _ = scoped_query(db, actor, scope)
            constraints = []
            for origin in original.get("_source_scopes") or [scope]:
                try:
                    narrowed, _ = scoped_query(db, actor, origin)
                except AppError as error:
                    if error.code in {"invalid_folder", "invalid_tags"}:
                        continue
                    raise
                ids = narrowed.with_only_columns(DocumentChunk.id).subquery()
                constraints.append(DocumentChunk.id.in_(select(ids.c.id)))
            if not constraints:
                raise AppError("not_found", "资料不可用", 404)
            base = base.where(Document.id == original["document_id"], or_(*constraints))
            source = original.get("source")
            if isinstance(source, dict) and source.get("chunk_id"):
                base = base.where(DocumentChunk.id == source["chunk_id"])
            row = db.execute(base.limit(1).execution_options(populate_existing=True)).first()
            if row is None:
                raise AppError("not_found", "资料不可用", 404)
            chunk, doc = row
            step["document_name"] = doc.display_name
            if isinstance(source, dict):
                step["source"] = visible_citation(db, actor, {**source, "document_id": doc.id,
                    "chunk_id": chunk.id, "anchors": chunk.anchors, "snippet": chunk.content[:400]}, kb_ids=scope["kb_ids"])
            step["available"] = True
        except AppError:
            for key in ("document_name", "document_id", "source", "scope_label", "detail", "query"):
                step.pop(key, None)
            step.update(available=False, detail="资料已删除或移出可访问范围")
        result.append(step)
    return result


def visible_retrieval(db, actor, scope, retrieval):
    if not isinstance(retrieval, dict):
        return retrieval
    result = {key: deepcopy(value) for key, value in retrieval.items() if not key.startswith("_")}
    if "execution" in result:
        result["execution"] = visible_execution(db, actor, scope, retrieval["execution"])
    return result
