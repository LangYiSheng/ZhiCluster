import math
import time
from datetime import datetime

from sqlalchemy import case, exists, func, or_, select

from app.ai.gateway import AIUnavailable, ModelGateway, ProviderError
from app.core.config import get_settings
from app.core.errors import AppError
from app.db.models import (
    ChunkEmbedding,
    Document,
    DocumentChunk,
    DocumentTag,
    EmbeddingProfile,
    Folder,
    KnowledgeBase,
    KnowledgeBaseMember,
    Tag,
)
from app.retrieval.evidence import MAX_CANDIDATES, rerank_evidence
from app.retrieval.ranking import diversify, document_purpose_weight, fuse_rankings, lexical_scores, snippet
from app.retrieval.terms import escape_like, plan_query, semantic_queries, term_weight
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
            folder = db.get(Folder, folder_id, populate_existing=True)
            if not folder or folder.kb_id not in kb_ids or folder.deleted_at:
                raise AppError("invalid_folder", "搜索文件夹不属于所选范围")
            expanded |= descendants(db, folder.kb_id, [folder.id]) if request.get("include_descendants", True) else {folder.id}
        stmt = stmt.where(Document.folder_id.in_(expanded))
    tags = request.get("tag_ids", [])
    for tag_id in tags:
        tag = db.get(Tag, tag_id, populate_existing=True)
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


def _candidates(db, stmt, order, limit, per_document):
    # Bound per-document admission before applying the global candidate limit.
    # Otherwise a filename match on a long document can consume the whole pool.
    ranked = stmt.with_only_columns(
        DocumentChunk.id.label("candidate_id"),
        func.row_number().over(partition_by=Document.id, order_by=(order, DocumentChunk.chunk_index)).label("document_rank"),
    ).subquery()
    return list(db.execute(stmt.join(ranked, ranked.c.candidate_id == DocumentChunk.id)
                           .where(ranked.c.document_rank <= per_document)
                           .order_by(order, DocumentChunk.id).limit(limit)))


def _current_candidates(db, actor, request, kb_ids, by_id):
    """Revalidate source access after a potentially slow provider round trip.

    Refresh only scope dependencies, preserving pending chat/job changes in the
    caller's session. Freeze the initial KB set: newly granted KBs cannot broaden
    an in-flight query, and revoking one of its KBs stops the response.
    """
    current_kbs = {
        kb.id: kb for kb in db.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(kb_ids))
                                      .execution_options(populate_existing=True))
    }
    list(db.scalars(select(KnowledgeBaseMember).where(
        KnowledgeBaseMember.kb_id.in_(kb_ids), KnowledgeBaseMember.user_id == actor.id,
    ).execution_options(populate_existing=True)))
    for kb_id in kb_ids:
        if kb_id not in current_kbs:
            raise AppError("not_found", "知识库不存在或已删除", 404)
        assert_can_read_kb(db, actor, kb_id)
    if request.get("folder_ids"):
        # descendants() consumes ORM folder relationships as well as IDs; make
        # moves in another transaction visible before expanding the tree again.
        list(db.scalars(select(Folder).where(Folder.kb_id.in_(kb_ids))
                        .execution_options(populate_existing=True)))
    current, _ = scoped_query(db, actor, {**request, "kb_ids": kb_ids})
    rows = db.execute(current.where(DocumentChunk.id.in_(by_id))
                      .execution_options(populate_existing=True))
    return {row[0].id: row for row in rows}


def search_knowledge(db, actor, request: dict, settings=None, *, on_progress=None, rerank=False):
    started = time.monotonic()
    settings = settings or get_runtime_settings(db, get_settings())
    query = request.get("query", "").strip()
    if not query:
        raise AppError("invalid_query", "请输入检索内容")
    stmt, kb_ids = scoped_query(db, actor, request)
    plan = plan_query(query)
    conditions, body_weights, title_weights = [], [], []
    for term in plan.terms:
        escaped = escape_like(term)
        body = DocumentChunk.content.ilike(f"%{escaped}%", escape="\\")
        title = Document.display_name.ilike(f"%{escaped}%", escape="\\")
        weight = term_weight(term, plan.query)
        conditions.extend((body, title))
        body_weights.append(case((body, weight), else_=0))
        title_weights.append(case((title, weight * 0.12), else_=0))
    postgres = db.bind.dialect.name == "postgresql"
    relevance = sum(body_weights) + sum(title_weights)
    requested = request.get("limit", 30) + request.get("offset", 0)
    candidate_limit = min(600, max(160, requested * 8))
    per_document = min(100, max(12, requested))
    if on_progress:
        on_progress("keyword", {"terms": len(plan.terms)})
    keywords = _candidates(db, stmt.where(or_(*conditions)), relevance.desc(), candidate_limit, per_document)
    lexical = lexical_scores(keywords, plan)
    keywords.sort(key=lambda row: (-lexical[row[0].id], row[0].id))
    by_id = {row[0].id: row for row in keywords}
    keyword_ranking = [row[0].id for row in keywords]
    vector_rankings = []
    mode, notice = "keyword", "仅关键词搜索：未配置 Embedding 服务"
    gateway = ModelGateway(settings)
    if request.get("mode", "hybrid") == "hybrid" and gateway.embeddings_configured:
        profile = db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.fingerprint == gateway.profile_fingerprint, EmbeddingProfile.status == "active"))
        if not profile:
            notice = "仅关键词搜索：当前模型尚未向量化，请在设置中重建索引"
        else:
            try:
                queries = semantic_queries(query)
                if on_progress:
                    on_progress("embedding", {"queries": len(queries)})
                query_vectors = gateway.embed(queries)
                if len(query_vectors) != len(queries) or any(len(vector) != profile.dimension for vector in query_vectors):
                    raise ProviderError("当前向量维度与索引不兼容，请重建索引")
                vector_stmt = stmt.join(ChunkEmbedding, ChunkEmbedding.chunk_id == DocumentChunk.id).where(ChunkEmbedding.profile_id == profile.id, ChunkEmbedding.kb_id.in_(kb_ids), Document.index_status == "ready")
                rows = list(db.execute(vector_stmt.add_columns(ChunkEmbedding.embedding))) if not postgres else []
                for vector in query_vectors:
                    if postgres:
                        vectors = _candidates(db, vector_stmt, ChunkEmbedding.embedding.cosine_distance(vector), candidate_limit, per_document)
                    else:
                        vectors = sorted(rows, key=lambda row: -cosine(row[2], vector))[:candidate_limit]
                    vector_rankings.append([row[0].id for row in vectors])
                    by_id.update({row[0].id: row for row in vectors})
                mode, notice = "hybrid", "关键词 + 当前模型精确 cosine 检索，复合问题分路融合"
            except (AIUnavailable, ProviderError) as exc:
                notice = f"仅关键词搜索：{exc}"
    elif request.get("mode") == "keyword":
        notice = "关键词搜索"
    if on_progress:
        on_progress("ranking", {"keyword_candidates": len(keywords), "vector_candidates": len(set().union(*map(set, vector_rankings))) if vector_rankings else 0})
    by_id = _current_candidates(db, actor, request, kb_ids, by_id)
    keyword_ranking = [key for key in keyword_ranking if key in by_id]
    vector_rankings = [[key for key in ranking if key in by_id] for ranking in vector_rankings]
    # Include semantic-only candidates in lexical reranking as well, rather than
    # silently assigning them zero simply because the SQL admission was bounded.
    lexical = lexical_scores(list(by_id.values()), plan)
    scores = fuse_rankings(keyword_ranking, vector_rankings, lexical)
    scores = {key: score * document_purpose_weight(by_id[key][1], query) for key, score in scores.items()}
    # Several semantic routes can contribute disjoint pools. Keep the expensive
    # diversity pass bounded independently of the number of subquestions.
    scores = dict(sorted(scores.items(), key=lambda item: (-item[1], item[0]))[:600])
    ranked = diversify(by_id, scores)
    reranking = {"status": "skipped"}
    if rerank and ranked and gateway.llm_configured:
        if on_progress:
            on_progress("reranking", {"candidates": min(MAX_CANDIDATES, len(ranked))})
        # This optional quality pass must not inherit long ingestion timeouts or
        # retry an entire selection several times before answering the user.
        rerank_settings = settings.model_copy(update={
            "llm_timeout_seconds": min(12, settings.llm_timeout_seconds), "llm_max_retries": 0,
        })
        ranked, reranking = rerank_evidence(query, by_id, ranked, ModelGateway(rerank_settings))
        by_id = _current_candidates(db, actor, request, kb_ids, by_id)
        ranked = [key for key in ranked if key in by_id]
        if reranking["status"] == "fallback":
            notice += "；证据重排暂不可用，已沿用本地排序"
    offset, limit = request.get("offset", 0), request.get("limit", 30)
    items = []
    for key in ranked[offset:offset + limit]:
        chunk, doc = by_id[key][:2]
        content = chunk.content
        items.append({"document_id": doc.id, "document_name": doc.display_name, "kb_id": doc.kb_id, "chunk_id": chunk.id, "section_id": chunk.section_id, "snippet": snippet(content, plan), "content": content, "anchors": chunk.anchors, "score": scores[key]})
    return {"items": items, "total": len(ranked), "mode": mode, "notice": notice, "elapsed_ms": round((time.monotonic() - started)*1000, 1), "kb_ids": kb_ids, "reranking": reranking}
