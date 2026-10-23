from datetime import UTC, timedelta
from typing import Literal

from fastapi import APIRouter, Body, Depends, Header, Query
from sqlalchemy import and_, exists, func, or_, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.ai.gateway import ModelGateway
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
    IngestionJob,
    JobEvent,
    Message,
    MessageCitation,
    utcnow,
)
from app.db.session import get_db
from app.retrieval.search import scoped_query, search_knowledge
from app.schemas.requests import ChatMessage, ConversationCreate, ConversationUpdate, Rebuild, Search
from app.schemas.responses import ConversationOut, JobOut, SearchOut
from app.schemas.settings import ConfigurationSave, ModelTestRequest
from app.services.chat import emit_chat
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
def model_status(db: Session = Depends(get_db, scope="function")):
    settings = get_runtime_settings(db, get_settings())
    gateway = ModelGateway(settings)
    profile = db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.fingerprint == gateway.profile_fingerprint))
    missing_vectors = True if not profile else exists(select(DocumentChunk.id).where(
        DocumentChunk.document_id == Document.id,
        ~exists(select(ChunkEmbedding.chunk_id).where(ChunkEmbedding.chunk_id == DocumentChunk.id, ChunkEmbedding.profile_id == profile.id)),
    ))
    pending = db.scalar(select(Document.id).where(Document.kb_id.in_(accessible_kb_ids(db, get_actor(db))), Document.deleted_at.is_(None), or_(Document.index_status != "ready", missing_vectors)).limit(1))
    return {"llm": {"configured": settings.llm_configured, "model": settings.llm_model}, "embedding": {"configured": settings.embedding_configured, "model": settings.embedding_model, "dimension": settings.embedding_dimension, "needs_rebuild": bool(settings.embedding_configured and (not profile or pending))}, "tool_calling": {"supported": settings.llm_supports_tools, "message": "请在设置中测试工具调用能力并保存配置"}, "configuration": "在网页设置中保存后，新请求和下一个后台任务自动使用新配置"}


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
    return search_knowledge(db, get_actor(db), body.model_dump())


@router.get("/ingestion/jobs", response_model=list[JobOut])
def jobs(kb_id: str | None = None, document_id: str | None = None, group: Literal["attention", "active", "completed"] | None = None, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    allowed = [kb_id] if kb_id else accessible_kb_ids(db, actor)
    if kb_id:
        assert_can_read_kb(db, actor, kb_id)
    stmt = select(IngestionJob, Document).outerjoin(Document, IngestionJob.document_id == Document.id).where(IngestionJob.kb_id.in_(allowed))
    own_conversation = exists(select(Conversation.id).where(Conversation.id == IngestionJob.payload["conversation_id"].as_string(), Conversation.user_id == actor.id, Conversation.deleted_at.is_(None)))
    stmt = stmt.where(or_(IngestionJob.kind != "chat", own_conversation))
    if document_id:
        document = get_document(db, actor, document_id)
        if kb_id and document.kb_id != kb_id:
            raise AppError("scope_mismatch", "文档不属于当前知识库", 400)
        stmt = stmt.where(IngestionJob.document_id == document_id)
    if group == "attention":
        stmt = stmt.where(or_(IngestionJob.status.in_(["failed", "partial_ready"]), and_(IngestionJob.status == "retry_wait", IngestionJob.error.is_not(None), IngestionJob.error != "")))
    elif group == "active":
        stmt = stmt.where(IngestionJob.status.in_(["queued", "running", "processing", "retry_wait"]))
    elif group == "completed":
        stmt = stmt.where(IngestionJob.status == "completed")
    return [{**snapshot(job), "document_name": document.display_name if document and not document.deleted_at else None, "document_available": not job.document_id or bool(document and not document.deleted_at)} for job, document in db.execute(stmt.order_by(IngestionJob.created_at.desc()).limit(200))]


def checked_job(db, job_id, edit=False):
    job = db.get(IngestionJob, job_id)
    if not job:
        raise AppError("not_found", "任务不存在", 404)
    (assert_can_edit_kb if edit else assert_can_read_kb)(db, get_actor(db), job.kb_id)
    if job.kind == "chat":
        checked_conversation(db, job.payload.get("conversation_id"))
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
    if job.kind == "agent":
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
    elif job.kind == "agent":
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
    for kb_id in conversation.scope.get("kb_ids", []):
        assert_can_read_kb(db, actor, kb_id)
    return conversation


@router.get("/conversations", response_model=list[ConversationOut])
def conversations(db: Session = Depends(get_db, scope="function")):
    return list(db.scalars(select(Conversation).where(Conversation.user_id == get_actor(db).id, Conversation.deleted_at.is_(None)).order_by(Conversation.updated_at.desc())))


@router.post("/conversations", status_code=201, response_model=ConversationOut)
def create_conversation(body: ConversationCreate, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    scope = Search.model_validate({**body.scope, "query": "scope validation"}).model_dump(exclude={"query", "mode", "limit", "offset"})
    if not scope["kb_ids"]:
        scope["kb_ids"] = accessible_kb_ids(db, actor)
    if not scope["kb_ids"]:
        raise AppError("empty_scope", "请先创建或恢复一个知识库后再开始对话", 400)
    for kb_id in scope["kb_ids"]:
        assert_can_read_kb(db, actor, kb_id)
    scoped_query(db, actor, scope)
    conversation = Conversation(user_id=actor.id, title=body.title, scope=scope)
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
    checked_conversation(db, conversation_id)
    result = []
    for message in db.scalars(select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at, Message.id)):
        item = snapshot(message)
        citations = []
        for citation in db.scalars(select(MessageCitation).where(MessageCitation.message_id == message.id).order_by(MessageCitation.ordinal)):
            data = snapshot(citation)
            try:
                doc = get_document(db, get_actor(db), citation.document_id)
                data["document_name"], data["available"] = doc.display_name, True
            except AppError:
                data["snippet"], data["available"] = "来源已删除或不可访问", False
            citations.append(data)
        item["citations"] = citations
        result.append(item)
    return result


@router.post("/conversations/{conversation_id}/messages", status_code=202)
def send_message(conversation_id: str, body: ChatMessage, db: Session = Depends(get_db, scope="function")):
    item = checked_conversation(db, conversation_id)
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
    job = IngestionJob(kb_id=item.scope["kb_ids"][0], kind="chat", payload={"conversation_id": item.id, "message_id": message.id})
    db.add(job)
    emit_chat(db, item.id, "status", {"message_id": message.id, "message": "已排队，正在检索资料"})
    return message


@router.get("/conversations/{conversation_id}/events")
def conversation_events(conversation_id: str, after: int = Query(0, ge=0), last_event_id: str | None = Header(None), db: Session = Depends(get_db, scope="function")):
    checked_conversation(db, conversation_id)
    cursor = int(last_event_id) if last_event_id and last_event_id.isdigit() else after
    def visible_event(session, item):
        data = dict(item.data)
        if item.type == "citation" and data.get("document_id"):
            try:
                get_document(session, get_actor(session), data["document_id"])
                data["available"] = True
            except AppError:
                data["snippet"], data["available"] = "来源已删除或不可访问", False
        return data

    return event_stream(ConversationEvent, ConversationEvent.conversation_id, conversation_id, cursor, terminal=lambda session: not session.scalar(select(Message.id).where(Message.conversation_id == conversation_id, Message.status.in_(["queued", "processing"]))), session_factory=sessionmaker(db.get_bind(), expire_on_commit=False), authorize=lambda session: checked_conversation(session, conversation_id), transform=visible_event)
