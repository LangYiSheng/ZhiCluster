import math
import time
from datetime import datetime

from sqlalchemy import case, exists, func, or_, select
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import UnaryExpression

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
from app.services.knowledge_settings import settings_for_knowledge_base
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
        folders = {folder.id: folder for folder in db.scalars(select(Folder).where(Folder.id.in_(folder_ids))
                                                             .execution_options(populate_existing=True))}
        grouped = {}
        for folder_id in folder_ids:
            folder = folders.get(folder_id)
            if not folder or folder.kb_id not in kb_ids or folder.deleted_at:
                raise AppError("invalid_folder", "搜索文件夹不属于所选范围")
            grouped.setdefault(folder.kb_id, set()).add(folder.id)
        for kb_id, roots in grouped.items():
            expanded |= descendants(db, kb_id, roots) if request.get("include_descendants", True) else roots
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
    # Trusted chat tools add intersections rather than replacing user filters.
    # This key is not accepted by the public Search input schema.
    for constraint in request.get("_scope_constraints", []):
        fixed_stmt, fixed_kb_ids = scoped_query(db, actor, constraint)
        fixed_chunks = fixed_stmt.with_only_columns(DocumentChunk.id).subquery()
        stmt = stmt.where(DocumentChunk.id.in_(select(fixed_chunks.c.id)))
        kb_ids = [kb_id for kb_id in kb_ids if kb_id in fixed_kb_ids]
    return stmt, kb_ids


def _candidates(db, stmt, order, limit, per_document):
    # Keep scope and the expensive relevance expression inside one windowed
    # candidate query. Hydrating its admitted IDs must not repeat those filters
    # or recompute the score in the outer entity query.
    directional = isinstance(order, UnaryExpression) and order.modifier in (operators.desc_op, operators.asc_op)
    descending = directional and order.modifier is operators.desc_op
    value = order.element if directional else order
    scoped = stmt.with_only_columns(
        DocumentChunk.id.label("candidate_id"),
        value.label("candidate_score"),
        func.row_number().over(partition_by=Document.id, order_by=(order, DocumentChunk.chunk_index)).label("document_rank"),
    ).cte("scoped_candidates")
    score_order = scoped.c.candidate_score.desc() if descending else scoped.c.candidate_score.asc()
    admitted = select(scoped.c.candidate_id, scoped.c.candidate_score, scoped.c.document_rank).where(
        scoped.c.document_rank <= per_document,
    ).order_by(score_order, scoped.c.document_rank, scoped.c.candidate_id).limit(limit).cte("admitted_candidates")
    final_order = admitted.c.candidate_score.desc() if descending else admitted.c.candidate_score.asc()
    return list(db.execute(select(DocumentChunk, Document).select_from(admitted)
                           .join(DocumentChunk, DocumentChunk.id == admitted.c.candidate_id)
                           .join(Document, Document.id == DocumentChunk.document_id)
                           .order_by(final_order, admitted.c.document_rank, DocumentChunk.id)))


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
    # scoped_query refreshes selected roots and descendants reads current scalar
    # parent IDs, so concurrent folder moves are re-expanded without loading the
    # entire folder tree as ORM entities here.
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
    # Rebuild the same bounded ranking window on every page. Growing admission
    # with offset changes IDF/diversity and can repeat or skip earlier hits.
    # Retain the existing maximum reachable window rather than truncating deep
    # pages to the smaller budget used by the old first-page request.
    candidate_limit = 600
    per_document = 100
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
    if request.get("mode", "hybrid") == "hybrid":
        groups = {}
        failures = []
        for kb in db.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(kb_ids))):
            configured = settings_for_knowledge_base(settings, kb)
            group_gateway = ModelGateway(configured)
            if not group_gateway.embeddings_configured:
                failures.append("部分知识库未配置 Embedding 服务")
                continue
            fingerprint = group_gateway.profile_fingerprint
            if fingerprint not in groups:
                groups[fingerprint] = (group_gateway, [])
            groups[fingerprint][1].append(kb.id)
        for fingerprint, (group_gateway, group_ids) in groups.items():
            profile = db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.fingerprint == fingerprint, EmbeddingProfile.status == "active"))
            if not profile:
                failures.append("部分知识库当前模型尚未向量化，请重建索引")
                continue
            try:
                queries = semantic_queries(query)
                if on_progress:
                    on_progress("embedding", {"query_count": len(queries), "knowledge_bases": len(group_ids)})
                query_vectors = group_gateway.embed(queries)
                if len(query_vectors) != len(queries) or any(len(vector) != profile.dimension for vector in query_vectors):
                    raise ProviderError("当前向量维度与索引不兼容，请重建索引")
                vector_stmt = stmt.join(ChunkEmbedding, ChunkEmbedding.chunk_id == DocumentChunk.id).where(ChunkEmbedding.profile_id == profile.id, ChunkEmbedding.kb_id.in_(group_ids), Document.index_status == "ready")
                rows = list(db.execute(vector_stmt.add_columns(ChunkEmbedding.embedding))) if not postgres else []
                for vector in query_vectors:
                    if postgres:
                        vectors = _candidates(db, vector_stmt, ChunkEmbedding.embedding.cosine_distance(vector), candidate_limit, per_document)
                    else:
                        vectors = sorted(rows, key=lambda row: -cosine(row[2], vector))[:candidate_limit]
                    vector_rankings.append([row[0].id for row in vectors])
                    by_id.update({row[0].id: row for row in vectors})
                mode, notice = "hybrid", "关键词 + 各知识库绑定模型的精确 cosine 检索，按排名融合"
            except (AIUnavailable, ProviderError) as exc:
                failures.append(str(exc))
        if failures:
            notice = (notice + "；" if mode == "hybrid" else "仅关键词搜索：") + "；".join(dict.fromkeys(failures))
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
    kb_names = {kb.id: kb.name for kb in db.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(kb_ids))
        .execution_options(populate_existing=True))}
    items = []
    for key in ranked[offset:offset + limit]:
        chunk, doc = by_id[key][:2]
        content = chunk.content
        items.append({"document_id": doc.id, "document_name": doc.display_name, "kb_id": doc.kb_id,
            "kb_name": kb_names.get(doc.kb_id), "ext": doc.ext, "chunk_id": chunk.id, "section_id": chunk.section_id,
            "snippet": snippet(content, plan), "content": content, "anchors": chunk.anchors, "score": scores[key]})
    return {"items": items, "total": len(ranked), "mode": mode, "notice": notice, "elapsed_ms": round((time.monotonic() - started)*1000, 1), "kb_ids": kb_ids, "reranking": reranking}
