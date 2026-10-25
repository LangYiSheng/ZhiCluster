from datetime import UTC, timedelta
from typing import Literal

from fastapi import APIRouter, Body, Depends, Header, Query
from sqlalchemy import and_, case, exists, func, or_, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.ai.gateway import ModelCatalogError, ModelGateway
from app.api.events import event_stream
from app.core.config import get_settings
from app.core.errors import AppError
from app.db.models import (
    AgentPlan,
    AgentRun,
    ChunkEmbedding,
    Conversation,
    ConversationEvent,
    Document,
    DocumentChunk,
    EmbeddingProfile,
    Folder,
    IngestionJob,
    JobEvent,
    KnowledgeBase,
    Message,
    MessageCitation,
    Tag,
    utcnow,
)
from app.db.session import get_db
from app.retrieval.search import scoped_query, search_knowledge
from app.schemas.requests import ChatMessage, ConversationCreate, ConversationUpdate, Rebuild, Search
from app.schemas.responses import ConversationOut, JobOut, JobPage, SearchOut
from app.schemas.settings import ConfigurationDraft, ConfigurationSave, ModelListRequest, ModelTestRequest
from app.services.chat import emit_chat
from app.services.citations import visible_citation
from app.services.knowledge_settings import chat_models, settings_for_knowledge_base
from app.services.library import get_document, snapshot
from app.services.permissions import accessible_kb_ids, assert_can_edit_kb, assert_can_read_kb, get_actor
from app.services.runtime_config import (
    apply_draft,
    get_runtime_settings,
    read_configuration,
    save_configuration,
)

router = APIRouter(prefix="/api")


@router.get("/health")
def health():
    return {"status": "ok", "version": "0.1.0"}


@router.get("/ready")
def ready(db: Session = Depends(get_db, scope="function")):
    db.execute(text("SELECT 1"))
    get_actor(db)
    return {"status": "ready"}


@router.get("/settings/model-status")
def model_status(kb_id: str | None = None, db: Session = Depends(get_db, scope="function")):
    settings = get_runtime_settings(db, get_settings())
    if kb_id:
        settings = settings_for_knowledge_base(settings, assert_can_read_kb(db, get_actor(db), kb_id))
    gateway = ModelGateway(settings)
    profile = db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.fingerprint == gateway.profile_fingerprint))
    missing_vectors = True if not profile else exists(select(DocumentChunk.id).where(
        DocumentChunk.document_id == Document.id,
        ~exists(select(ChunkEmbedding.chunk_id).where(ChunkEmbedding.chunk_id == DocumentChunk.id, ChunkEmbedding.profile_id == profile.id)),
    ))
    status_kb_ids = [kb_id] if kb_id else accessible_kb_ids(db, get_actor(db))
    pending = db.scalar(select(Document.id).where(Document.kb_id.in_(status_kb_ids), Document.deleted_at.is_(None), or_(Document.index_status != "ready", missing_vectors)).limit(1))
    return {"llm": {"configured": settings.llm_configured, "model": settings.llm_model}, "embedding": {"configured": settings.embedding_configured, "model": settings.embedding_model, "dimension": settings.embedding_dimension, "needs_rebuild": bool(settings.embedding_configured and (not profile or pending))}, "tool_calling": {"supported": settings.llm_supports_tools, "message": "请在设置中测试工具调用能力并保存配置"}, "configuration": "在网页设置中保存后，新请求和下一个后台任务自动使用新配置"}


@router.get("/settings/chat-models")
def available_chat_models(db: Session = Depends(get_db, scope="function")):
    get_actor(db)
    settings = get_runtime_settings(db, get_settings())
    return {"models": chat_models(settings), "default_model": settings.llm_model, "supports_tools": settings.llm_supports_tools}


@router.get("/settings/statistics")
def statistics(kb_id: str | None = None, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    ids = [assert_can_read_kb(db, actor, kb_id).id] if kb_id else accessible_kb_ids(db, actor)
    docs = select(Document.id).where(Document.kb_id.in_(ids), Document.deleted_at.is_(None))
    chats = select(Conversation.id).where(Conversation.user_id == actor.id, Conversation.kb_id.in_(ids), Conversation.deleted_at.is_(None))

    def count(model, *conditions):
        return db.scalar(select(func.count()).select_from(model).where(*conditions)) or 0

    settings = get_runtime_settings(db, get_settings())
    profile_groups = {}
    for kb in db.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(ids))):
        fingerprint = ModelGateway(settings_for_knowledge_base(settings, kb)).profile_fingerprint
        profile_groups.setdefault(fingerprint, []).append(kb.id)
    indexed_documents = 0
    for profile in db.scalars(select(EmbeddingProfile).where(EmbeddingProfile.fingerprint.in_(profile_groups),
            EmbeddingProfile.status == "active")):
        has_chunks = exists(select(DocumentChunk.id).where(DocumentChunk.document_id == Document.id))
        missing_vectors = exists(select(DocumentChunk.id).where(DocumentChunk.document_id == Document.id,
            ~exists(select(ChunkEmbedding.id).where(ChunkEmbedding.chunk_id == DocumentChunk.id,
                ChunkEmbedding.profile_id == profile.id))))
        indexed_documents += count(Document, Document.id.in_(docs),
            Document.kb_id.in_(profile_groups[profile.fingerprint]), Document.index_status == "ready", has_chunks, ~missing_vectors)

    return {"knowledge_bases": len(ids), "documents": count(Document, Document.id.in_(docs)),
        "folders": count(Folder, Folder.kb_id.in_(ids), Folder.deleted_at.is_(None)),
        "tags": count(Tag, Tag.kb_id.in_(ids)), "conversations": count(Conversation, Conversation.id.in_(chats)),
        "messages": count(Message, Message.conversation_id.in_(chats)),
        "storage_bytes": db.scalar(select(func.coalesce(func.sum(Document.size_bytes), 0)).where(Document.id.in_(docs))) or 0,
        "chunks": count(DocumentChunk, DocumentChunk.document_id.in_(docs)),
        "indexed_documents": indexed_documents,
        "failed_jobs": db.scalar(select(func.count()).select_from(_job_scope(db, actor, kb_id).where(IngestionJob.status == "failed").subquery())) or 0}


@router.get("/settings/config")
def configuration(db: Session = Depends(get_db, scope="function")):
    get_actor(db)
    return read_configuration(db, get_settings())


@router.put("/settings/config")
def update_configuration(body: ConfigurationSave, db: Session = Depends(get_db, scope="function")):
    get_actor(db)
    return save_configuration(db, body, get_settings())


@router.post("/settings/test-models")
def test_models(body: ModelTestRequest | None = Body(None), db: Session = Depends(get_db, scope="function")):
    settings = get_runtime_settings(db, get_settings())
    settings = apply_draft(settings, body.draft if body else None)
    return ModelGateway(settings).test_models(scope=body.scope if body else None)


@router.post("/settings/models")
def model_catalog(body: ModelListRequest, db: Session = Depends(get_db, scope="function")):
    get_actor(db)
    settings = get_runtime_settings(db, get_settings())
    patch = getattr(body.draft, body.scope) if body.draft else None
    if patch and patch.base_url is not None:
        saved_url = str(getattr(settings, f"{body.scope}_base_url", "")).strip().rstrip("/")
        if patch.base_url != saved_url and not (patch.api_key and patch.api_key.get_secret_value()):
            raise AppError("model_list_key_required", "服务地址已变更，请重新填写 API Key 后获取模型列表", 422)
    # A catalog lookup neither saves drafts nor applies the other provider's
    # unsaved fields (including unrelated processing configuration).
    draft = ConfigurationDraft(**{body.scope: getattr(body.draft, body.scope)}) if body.draft else None
    settings = apply_draft(settings, draft)
    try:
        identifiers = ModelGateway(settings).list_models(body.scope)
    except ModelCatalogError as error:
        raise AppError(error.code, str(error), error.status) from error
    result = {"models": [{"id": identifier} for identifier in identifiers]}
    if not identifiers:
        result["message"] = "此服务没有返回可用模型，可以刷新列表或手动填写模型 ID"
    return result


@router.post("/settings/rebuild-embeddings")
def rebuild(body: Rebuild, db: Session = Depends(get_db, scope="function")):
    assert_can_edit_kb(db, get_actor(db), body.kb_id)
    jobs = []
    for doc in db.scalars(select(Document).where(Document.kb_id == body.kb_id, Document.deleted_at.is_(None), Document.parse_status == "ready")):
        existing = db.scalar(select(IngestionJob).where(IngestionJob.document_id == doc.id, IngestionJob.status.in_(["queued", "running", "processing"])))
        if existing:
            continue
        doc.index_status = "queued"
        job = IngestionJob(document_id=doc.id, kb_id=doc.kb_id, kind="reindex")
        db.add(job)
        db.flush()
        jobs.append(snapshot(job))
    return {"jobs": jobs}


@router.post("/search", response_model=SearchOut)
def search(body: Search, db: Session = Depends(get_db, scope="function")):
    return search_knowledge(db, get_actor(db), body.model_dump(), rerank=body.rerank)


def _job_scope(db, actor, kb_id=None, document_id=None):
    """One visibility boundary for history, current status and aggregate counts."""
    allowed = [kb_id] if kb_id else accessible_kb_ids(db, actor)
    if kb_id:
        assert_can_read_kb(db, actor, kb_id)
    # Project exactly the public fields. Polling does not need document summaries,
    # job payloads, or lease internals, which can grow much larger than status.
    stmt = select(IngestionJob.id, IngestionJob.created_at, IngestionJob.updated_at,
        IngestionJob.kb_id, IngestionJob.document_id, IngestionJob.kind, IngestionJob.status,
        IngestionJob.stage, IngestionJob.progress, IngestionJob.attempts, IngestionJob.error,
        IngestionJob.next_attempt_at, Document.display_name.label("document_name"),
        Document.deleted_at.label("document_deleted_at"), Document.id.label("available_document_id")).outerjoin(
        Document, IngestionJob.document_id == Document.id).where(IngestionJob.kb_id.in_(allowed))
    own_conversation = exists(select(Conversation.id).where(Conversation.id == IngestionJob.payload["conversation_id"].as_string(), Conversation.user_id == actor.id, Conversation.deleted_at.is_(None)))
    stmt = stmt.where(or_(IngestionJob.kind != "chat", own_conversation))
    own_run = exists(select(AgentRun.id).where(AgentRun.id == IngestionJob.payload["run_id"].as_string(), AgentRun.actor_id == actor.id))
    stmt = stmt.where(or_(IngestionJob.kind.not_in(["agent", "organize"]), own_run))
    if document_id:
        document = get_document(db, actor, document_id)
        if kb_id and document.kb_id != kb_id:
            raise AppError("scope_mismatch", "文档不属于当前知识库", 400)
        stmt = stmt.where(IngestionJob.document_id == document_id)
    return stmt


def _job_group(group, model=IngestionJob):
    return {
        "attention": or_(model.status.in_(["failed", "partial_ready"]),
            and_(model.status == "retry_wait", model.error.is_not(None), model.error != "")),
        "active": model.status.in_(["queued", "running", "processing", "retry_wait"]),
        "completed": model.status == "completed",
    }.get(group)


def _job_items(db, stmt):
    items = []
    for row in db.execute(stmt):
        item = dict(row._mapping)
        available_id = item.pop("available_document_id")
        deleted_at = item.pop("document_deleted_at")
        available = bool(available_id and not deleted_at)
        if not available:
            item["document_name"] = None
        item["document_available"] = not item["document_id"] or available
        items.append(item)
    return items


@router.get("/ingestion/jobs", response_model=list[JobOut])
def jobs(kb_id: str | None = None, document_id: str | None = None,
    group: Literal["attention", "active", "completed"] | None = None, document_ids: str | None = None,
    view: Literal["current"] | None = None, db: Session = Depends(get_db, scope="function")):
    stmt = _job_scope(db, get_actor(db), kb_id, document_id)
    if document_ids is not None:
        if len(document_ids) > 7400:
            raise AppError("invalid_documents", "请提供 1 至 200 个有效文档 ID")
        ids = list(dict.fromkeys(value.strip() for value in document_ids.split(",") if value.strip()))
        if not ids or len(ids) > 200 or any(len(value) > 36 for value in ids):
            raise AppError("invalid_documents", "请提供 1 至 200 个有效文档 ID")
        # A batch ID filter never broadens the established KB/actor boundary.
        stmt = stmt.where(IngestionJob.document_id.in_(ids), Document.deleted_at.is_(None), Document.id.is_not(None))
    if group:
        stmt = stmt.where(_job_group(group))
    if view == "current":
        if document_ids is None or group:
            raise AppError("invalid_job_view", "当前状态视图需要文档 ID 列表，且不能同时筛选任务分组")
        priority = case((IngestionJob.status.in_(["running", "processing"]), 0),
            (IngestionJob.status.in_(["queued", "retry_wait"]), 1), else_=2)
        ranked = stmt.with_only_columns(IngestionJob.id.label("job_id"), func.row_number().over(
            partition_by=IngestionJob.document_id,
            order_by=(priority, IngestionJob.created_at.desc(), IngestionJob.id.desc()),
        ).label("document_rank")).subquery()
        stmt = stmt.where(IngestionJob.id.in_(select(ranked.c.job_id).where(ranked.c.document_rank == 1)))
    return _job_items(db, stmt.order_by(IngestionJob.created_at.desc(), IngestionJob.id.desc()).limit(200))


@router.get("/ingestion/jobs/page", response_model=JobPage)
def job_page(kb_id: str | None = None, document_id: str | None = None,
    group: Literal["attention", "active", "completed"] | None = None,
    page: int = Query(1, ge=1, le=1000000), page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db, scope="function")):
    stmt = _job_scope(db, get_actor(db), kb_id, document_id)
    scoped = stmt.with_only_columns(IngestionJob.id, IngestionJob.status, IngestionJob.error).subquery()
    # Counts are for the complete visible scope; a retry_wait with an error
    # belongs to both active and attention, so these categories are not summed.
    counts = dict(db.execute(select(func.count().label("all"), *[
        func.coalesce(func.sum(case((_job_group(name, scoped.c), 1), else_=0)), 0).label(name)
        for name in ("attention", "active", "completed")
    ]).select_from(scoped)).one()._mapping)
    if group:
        stmt = stmt.where(_job_group(group))
    items = _job_items(db, stmt.order_by(IngestionJob.created_at.desc(), IngestionJob.id.desc())
        .offset((page - 1) * page_size).limit(page_size))
    return {"items": items, "total": counts[group or "all"], "page": page, "page_size": page_size, "counts": counts}


def checked_job(db, job_id, edit=False):
    job = db.get(IngestionJob, job_id)
    if not job:
        raise AppError("not_found", "任务不存在", 404)
    (assert_can_edit_kb if edit else assert_can_read_kb)(db, get_actor(db), job.kb_id)
    if job.kind == "chat":
        checked_conversation(db, job.payload.get("conversation_id"))
    elif job.kind in {"agent", "organize"}:
        from app.agent.executor import get_run

        get_run(db, get_actor(db), job.payload.get("run_id"))
    return job


@router.get("/ingestion/jobs/{job_id}", response_model=JobOut)
def job_status(job_id: str, db: Session = Depends(get_db, scope="function")):
    return checked_job(db, job_id)


@router.post("/ingestion/jobs/{job_id}/retry")
def retry_job(job_id: str, db: Session = Depends(get_db, scope="function")):
    job = checked_job(db, job_id, True)
    db.refresh(job, with_for_update=True)
    if job.status not in {"failed", "partial_ready", "cancelled", "completed"}:
        raise AppError("job_running", "任务正在执行", 409)
    if job.document_id:
        get_document(db, get_actor(db), job.document_id)
    if job.kind == "chat":
        conversation = db.scalar(select(Conversation).where(Conversation.id == job.payload.get("conversation_id")).with_for_update())
        if not conversation or conversation.deleted_at or conversation.user_id != get_actor(db).id:
            raise AppError("not_found", "对话不存在", 404)
        message = db.get(Message, job.payload.get("message_id"))
        if not message or message.status == "completed":
            raise AppError("chat_already_completed", "此回答已经完成", 409)
        active = db.scalar(select(Message).where(Message.conversation_id == conversation.id, Message.id != message.id, Message.status.in_(["queued", "processing"])))
        if active:
            raise AppError("conversation_busy", "请等待当前回复完成后重试", 409)
        later = db.scalar(select(Message.id).where(Message.conversation_id == conversation.id, Message.created_at > message.created_at).limit(1))
        if later:
            raise AppError("chat_turn_is_past", "此回答之后已有新对话，请回到知识对话重新提问", 409)
        message.status, message.error = "queued", None
    if job.kind in {"agent", "organize"}:
        run = db.scalar(select(AgentRun).where(AgentRun.id == job.payload.get("run_id")).with_for_update().execution_options(populate_existing=True))
        if db.scalar(select(AgentPlan.id).where(AgentPlan.run_id == job.payload.get("run_id"))):
            raise AppError("agent_already_planned", "此任务已有整理计划，请重新打开计划或创建新的整理任务", 409)
        if run:
            run.status, run.error = "queued", None
    job.status, job.error, job.attempts = "queued", None, 0
    job.stage, job.progress = "queued", 0
    job.lease_until, job.lease_owner, job.next_attempt_at = None, None, None
    if job.document_id:
        doc = db.get(Document, job.document_id)
        for field in ("parse_status", "index_status", "summary_status", "classification_status"):
            if getattr(doc, field) in {"failed", "unconfigured"}:
                setattr(doc, field, "queued")
    return job


@router.post("/ingestion/jobs/{job_id}/cancel")
def cancel_job(job_id: str, db: Session = Depends(get_db, scope="function")):
    job = checked_job(db, job_id, True)
    db.refresh(job, with_for_update=True)
    if job.status not in {"queued", "running", "processing", "retry_wait"}:
        raise AppError("job_terminal", "任务已经结束", 409)
    job.status = "cancelled"
    if job.kind == "chat":
        message = db.get(Message, job.payload.get("message_id"))
        if message and message.status in {"queued", "processing"}:
            message.status, message.error = "failed", "用户已取消生成"
            emit_chat(db, message.conversation_id, "error", {"message_id": message.id, "message": message.error})
    elif job.kind in {"agent", "organize"}:
        from app.agent.executor import emit_event

        run = db.scalar(select(AgentRun).where(AgentRun.id == job.payload.get("run_id")).with_for_update().execution_options(populate_existing=True))
        if run:
            run.status, run.error = "cancelled", "整理任务已取消"
            emit_event(db, run.id, "completed", {"message": run.error, "status": "cancelled"})
            plan = db.scalar(select(AgentPlan).where(AgentPlan.run_id == run.id).with_for_update().execution_options(populate_existing=True))
            if plan and plan.status == "pending_review":
                plan.status = "cancelled"
                plan.payload = {**plan.payload, "status": "cancelled"}
    return job


@router.get("/ingestion/jobs/{job_id}/events")
def job_events(job_id: str, after: int = Query(0, ge=0), last_event_id: str | None = Header(None), db: Session = Depends(get_db, scope="function")):
    checked_job(db, job_id)
    cursor = int(last_event_id) if last_event_id and last_event_id.isdigit() else after
    return event_stream(JobEvent, JobEvent.job_id, job_id, cursor, terminal=lambda session: session.get(IngestionJob, job_id).status in {"completed", "partial_ready", "failed", "cancelled"}, session_factory=sessionmaker(db.get_bind(), expire_on_commit=False), authorize=lambda session: checked_job(session, job_id))


def checked_conversation(db, conversation_id):
    conversation = db.get(Conversation, conversation_id)
    actor = get_actor(db)
    if not conversation or conversation.user_id != actor.id or conversation.deleted_at:
        raise AppError("not_found", "对话不存在", 404)
    if not conversation.scope.get("kb_ids"):
        raise AppError("empty_scope", "请先创建或选择一个可访问的知识库", 400)
    if conversation.kb_id:
        assert_can_read_kb(db, actor, conversation.kb_id)
    for kb_id in conversation.scope.get("kb_ids", []):
        assert_can_read_kb(db, actor, kb_id)
    return conversation


@router.get("/conversations", response_model=list[ConversationOut])
def conversations(kb_id: str | None = None, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    stmt = select(Conversation).where(Conversation.user_id == actor.id, Conversation.deleted_at.is_(None))
    if kb_id:
        assert_can_read_kb(db, actor, kb_id)
        stmt = stmt.where(Conversation.kb_id == kb_id)
    return list(db.scalars(stmt.order_by(Conversation.updated_at.desc())))


@router.post("/conversations", status_code=201, response_model=ConversationOut)
def create_conversation(body: ConversationCreate, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    scope = Search.model_validate({**body.scope, "query": "scope validation"}).model_dump(exclude={"query", "mode", "limit", "offset"})
    if not scope["kb_ids"]:
        scope["kb_ids"] = [body.kb_id] if body.kb_id else accessible_kb_ids(db, actor)
    if not scope["kb_ids"]:
        raise AppError("empty_scope", "请先创建或恢复一个知识库后再开始对话", 400)
    for kb_id in scope["kb_ids"]:
        assert_can_read_kb(db, actor, kb_id)
    scoped_query(db, actor, scope)
    owning_kb_id = body.kb_id or scope["kb_ids"][0]
    assert_can_read_kb(db, actor, owning_kb_id)
    conversation = Conversation(user_id=actor.id, kb_id=owning_kb_id, title=body.title, scope=scope)
    db.add(conversation)
    db.flush()
    return conversation


@router.get("/conversations/{conversation_id}")
def conversation(conversation_id: str, db: Session = Depends(get_db, scope="function")):
    return checked_conversation(db, conversation_id)


@router.patch("/conversations/{conversation_id}")
def rename_conversation(conversation_id: str, body: ConversationUpdate, db: Session = Depends(get_db, scope="function")):
    item = checked_conversation(db, conversation_id)
    item.title = body.title
    return item


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, db: Session = Depends(get_db, scope="function")):
    item = checked_conversation(db, conversation_id)
    item.deleted_at = utcnow()
    return {"status": "deleted"}


@router.get("/conversations/{conversation_id}/messages")
def messages(conversation_id: str, db: Session = Depends(get_db, scope="function")):
    conversation = checked_conversation(db, conversation_id)
    result = []
    for message in db.scalars(select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at, Message.id)):
        item = snapshot(message)
        citations = []
        for citation in db.scalars(select(MessageCitation).where(MessageCitation.message_id == message.id).order_by(MessageCitation.ordinal)):
            citations.append(visible_citation(db, get_actor(db), snapshot(citation), kb_ids=conversation.scope["kb_ids"]))
        item["citations"] = citations
        result.append(item)
    return result


@router.post("/conversations/{conversation_id}/messages", status_code=202)
def send_message(conversation_id: str, body: ChatMessage, db: Session = Depends(get_db, scope="function")):
    item = checked_conversation(db, conversation_id)
    settings = get_runtime_settings(db, get_settings())
    selected_model = body.model or settings.llm_model
    if body.model and selected_model not in chat_models(settings):
        raise AppError("invalid_chat_model", "请选择已配置的聊天模型", 422)
    db.refresh(item, with_for_update=True)
    active = db.scalar(select(Message).where(Message.conversation_id == item.id, Message.status.in_(["queued", "processing"])))
    if active:
        raise AppError("conversation_busy", "请等待当前回复完成", 409)
    # The conversation lock serializes this allocation across turns/processes.
    # Clock ticks (or clock rollback) must never make UUID ordering reorder turns.
    last_created_at = db.scalar(select(func.max(Message.created_at)).where(Message.conversation_id == item.id))
    created_at = utcnow()
    if last_created_at is not None:
        if last_created_at.tzinfo is None:  # SQLite strips timezone information.
            last_created_at = last_created_at.replace(tzinfo=UTC)
        created_at = max(created_at, last_created_at + timedelta(microseconds=1))
    db.add(Message(conversation_id=item.id, role="user", content=body.content, created_at=created_at))
    db.flush()
    message = Message(conversation_id=item.id, role="assistant", status="queued", created_at=created_at + timedelta(microseconds=1))
    db.add(message)
    db.flush()
    job = IngestionJob(kb_id=item.kb_id or item.scope["kb_ids"][0], kind="chat", payload={"conversation_id": item.id, "message_id": message.id,
        "retrieval_mode": body.retrieval_mode, "model": selected_model})
    db.add(job)
    sequence = emit_chat(db, item.id, "status", {"message_id": message.id, "message": "已排队，等待检索资料"})
    message.retrieval = {"stream_sequence": sequence, "retrieval_mode": body.retrieval_mode, "model": selected_model}
    return message


@router.get("/conversations/{conversation_id}/events")
def conversation_events(conversation_id: str, after: int = Query(0, ge=0), last_event_id: str | None = Header(None), db: Session = Depends(get_db, scope="function")):
    checked_conversation(db, conversation_id)
    cursor = int(last_event_id) if last_event_id and last_event_id.isdigit() else after
    def visible_event(session, item):
        data = dict(item.data)
        if item.type == "citation":
            conversation = checked_conversation(session, conversation_id)
            data = visible_citation(session, get_actor(session), data, kb_ids=conversation.scope["kb_ids"])
        return data

    return event_stream(ConversationEvent, ConversationEvent.conversation_id, conversation_id, cursor, terminal=lambda session: not session.scalar(select(Message.id).where(Message.conversation_id == conversation_id, Message.status.in_(["queued", "processing"]))), session_factory=sessionmaker(db.get_bind(), expire_on_commit=False), authorize=lambda session: checked_conversation(session, conversation_id), transform=visible_event)
