import math
import re
import time
from datetime import datetime

from sqlalchemy import case, exists, func, or_, select

from app.ai.gateway import AIUnavailable, ModelGateway, ProviderError
from app.core.config import get_settings
from app.core.errors import AppError
from app.db.models import ChunkEmbedding, Document, DocumentChunk, DocumentTag, EmbeddingProfile, Folder, Tag
from app.services.library import descendants
from app.services.permissions import accessible_kb_ids, assert_can_read_kb
from app.services.runtime_config import get_runtime_settings


def rrf(rankings, k=60):
    scores = {}
    for ranking in rankings:
        for rank, item in enumerate(dict.fromkeys(ranking), 1):
            scores[item] = scores.get(item, 0) + 1 / (k + rank)
    return sorted(scores, key=lambda item: (-scores[item], item)), scores


def cosine(a, b):
    if len(a) != len(b):
        raise ValueError("Embedding dimension mismatch")
    norm = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    return sum(x*y for x, y in zip(a, b, strict=True)) / norm if norm else 0


def scoped_query(db, actor, request):
    kb_ids = request.get("kb_ids") or accessible_kb_ids(db, actor)
    for kb_id in kb_ids:
        assert_can_read_kb(db, actor, kb_id)
    stmt = select(DocumentChunk, Document).join(Document, Document.id == DocumentChunk.document_id).where(
        DocumentChunk.kb_id.in_(kb_ids), Document.kb_id.in_(kb_ids), Document.deleted_at.is_(None), Document.parse_status == "ready",
        or_(Document.folder_id.is_(None), exists(select(Folder.id).where(Folder.id == Document.folder_id, Folder.deleted_at.is_(None)))),
    )
    folder_ids = request.get("folder_ids", [])
    if folder_ids:
        expanded = set()
        for folder_id in folder_ids:
            folder = db.get(Folder, folder_id)
            if not folder or folder.kb_id not in kb_ids or folder.deleted_at:
                raise AppError("invalid_folder", "搜索文件夹不属于所选范围")
            expanded |= descendants(db, folder.kb_id, [folder.id]) if request.get("include_descendants", True) else {folder.id}
        stmt = stmt.where(Document.folder_id.in_(expanded))
    tags = request.get("tag_ids", [])
    for tag_id in tags:
        tag = db.get(Tag, tag_id)
        if not tag or tag.kb_id not in kb_ids:
            raise AppError("invalid_tags", "搜索标签不属于所选范围")
    if tags:
        if request.get("tag_match", "all") == "any":
            stmt = stmt.where(Document.id.in_(select(DocumentTag.document_id).where(DocumentTag.tag_id.in_(tags))))
        else:
            for tag_id in tags:
                stmt = stmt.where(Document.id.in_(select(DocumentTag.document_id).where(DocumentTag.tag_id == tag_id)))
    if request.get("document_ids"):
        stmt = stmt.where(Document.id.in_(request["document_ids"]))
    if request.get("exts"):
        stmt = stmt.where(Document.ext.in_(request["exts"]))
    for key, operator in [("date_from", Document.created_at.__ge__), ("date_to", Document.created_at.__le__)]:
        if request.get(key):
            try:
                stmt = stmt.where(operator(datetime.fromisoformat(request[key])))
            except ValueError as exc:
                raise AppError("invalid_date", "日期需要 ISO 8601 格式") from exc
    return stmt, kb_ids


def search_knowledge(db, actor, request: dict, settings=None):
    started = time.monotonic()
    settings = settings or get_runtime_settings(db, get_settings())
    query = request.get("query", "").strip()
    if not query:
        raise AppError("invalid_query", "请输入检索内容")
    stmt, kb_ids = scoped_query(db, actor, request)
    tokens = list(dict.fromkeys([query, *re.findall(r"[\w\u4e00-\u9fff]+", query)]))[:12]
    # Chinese text has no word separators: bounded n-grams give a deterministic
    # keyword fallback for natural questions without pretending to be semantic search.
    for run in re.findall(r"[\u4e00-\u9fff]{3,}", query):
        tokens.extend(run[i:i + size] for size in (3, 2) for i in range(len(run) - size + 1))
    tokens = list(dict.fromkeys(tokens))[:80]
    conditions = []
    for token in tokens:
        escaped = token.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        conditions.extend([DocumentChunk.content.ilike(f"%{escaped}%", escape="\\"), Document.display_name.ilike(f"%{escaped}%", escape="\\")])
    postgres = db.bind.dialect.name == "postgresql"
    overlap = sum(case((condition, 1), else_=0) for condition in conditions)
    relevance = overlap + ((func.similarity(DocumentChunk.content, query) + func.similarity(Document.display_name, query)) if postgres else 0)
    candidate_limit = min(500, max(80, request.get("limit", 30) + request.get("offset", 0)))
    keywords = list(db.execute(stmt.where(or_(*conditions)).order_by(relevance.desc(), DocumentChunk.id).limit(candidate_limit)))
    by_id = {row[0].id: row for row in keywords}
    rankings = [[row[0].id for row in keywords]]
    mode, notice = "keyword", "仅关键词搜索：未配置 Embedding 服务"
    gateway = ModelGateway(settings)
    if request.get("mode", "hybrid") == "hybrid" and gateway.embeddings_configured:
        profile = db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.fingerprint == gateway.profile_fingerprint, EmbeddingProfile.status == "active"))
        if not profile:
            notice = "仅关键词搜索：当前模型尚未向量化，请在设置中重建索引"
        else:
            try:
                vector = gateway.embed([query])[0]
                if len(vector) != profile.dimension:
                    raise ProviderError("当前向量维度与索引不兼容，请重建索引")
                vector_stmt = stmt.join(ChunkEmbedding, ChunkEmbedding.chunk_id == DocumentChunk.id).where(ChunkEmbedding.profile_id == profile.id, ChunkEmbedding.kb_id.in_(kb_ids), Document.index_status == "ready")
                if postgres:
                    vectors = list(db.execute(vector_stmt.order_by(ChunkEmbedding.embedding.cosine_distance(vector)).limit(candidate_limit)))
                else:
                    rows = list(db.execute(vector_stmt.add_columns(ChunkEmbedding.embedding)))
                    vectors = sorted(rows, key=lambda row: -cosine(row[2], vector))[:candidate_limit]
                rankings.append([row[0].id for row in vectors])
                by_id.update({row[0].id: row for row in vectors})
                mode, notice = "hybrid", "关键词 + 当前模型精确 cosine 检索，RRF 融合"
            except (AIUnavailable, ProviderError) as exc:
                notice = f"仅关键词搜索：{exc}"
    elif request.get("mode") == "keyword":
        notice = "关键词搜索"
    ranked, scores = rrf(rankings)
    offset, limit = request.get("offset", 0), request.get("limit", 30)
    items = []
    for key in ranked[offset:offset + limit]:
        chunk, doc = by_id[key][:2]
        content = chunk.content
        pos = max(0, content.casefold().find(query.casefold()) - 100)
        items.append({"document_id": doc.id, "document_name": doc.display_name, "kb_id": doc.kb_id, "chunk_id": chunk.id, "section_id": chunk.section_id, "snippet": content[pos:pos + 700], "content": content, "anchors": chunk.anchors, "score": scores[key]})
    return {"items": items, "total": len(ranked), "mode": mode, "notice": notice, "elapsed_ms": round((time.monotonic() - started)*1000, 1), "kb_ids": kb_ids}
