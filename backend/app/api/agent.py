import json
import time

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agent.executor import edit_plan, execute_plan, get_plan, get_run, reject_plan, undo_run
from app.agent.graph import resume_plan
from app.agent.plans import ApproveRequest, PlanEdit, RunRequest
from app.core.config import get_settings
from app.core.errors import AppError
from app.db.models import AgentEvent, AgentPlan, AgentRun, AuditLog, IngestionJob, KnowledgeBaseMember, new_id
from app.db.session import get_db
from app.services.library import snapshot
from app.services.permissions import accessible_kb_ids, assert_can_edit_kb, get_actor
from app.services.review import plan_preview
from app.services.runtime_config import get_runtime_settings

router = APIRouter(prefix="/agent", tags=["agent"])


def serialize_plan(plan, db):
    return {**snapshot(plan), "preview": plan_preview(db, plan)} if plan else None


@router.get("/runs")
def list_runs(kb_id: str | None = None, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    allowed = [kb_id] if kb_id else accessible_kb_ids(db, actor)
    if kb_id:
        assert_can_edit_kb(db, actor, kb_id)
    else:
        allowed = list(db.scalars(select(KnowledgeBaseMember.kb_id).where(KnowledgeBaseMember.user_id == actor.id,
            KnowledgeBaseMember.kb_id.in_(allowed), KnowledgeBaseMember.role.in_(["owner", "editor"]))))
    return [snapshot(run) for run in db.scalars(select(AgentRun).where(AgentRun.kb_id.in_(allowed),
        AgentRun.actor_id == actor.id).order_by(AgentRun.created_at.desc()).limit(50))]


@router.post("/runs", status_code=201)
def create_run(body: RunRequest, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    assert_can_edit_kb(db, actor, body.kb_id)
    if not get_runtime_settings(db, get_settings()).llm_configured:
        raise AppError("model_not_configured", "智能整理需要配置聊天模型服务；请前往设置检查连接和 Tool Calling", 503)
    run = AgentRun(kb_id=body.kb_id, actor_id=actor.id, thread_id=new_id(), goal=body.goal)
    db.add(run)
    db.flush()
    db.add(IngestionJob(kb_id=body.kb_id, document_id=None, kind="agent", payload={"run_id": run.id}))
    return snapshot(run)


@router.get("/runs/{run_id}")
def read_run(run_id: str, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    run = get_run(db, actor, run_id)
    plan = db.scalar(select(AgentPlan).where(AgentPlan.run_id == run.id))
    events = list(db.scalars(select(AgentEvent).where(AgentEvent.run_id == run.id).order_by(AgentEvent.sequence)))
    audits = list(db.scalars(select(AuditLog).where(AuditLog.run_id == run.id).order_by(AuditLog.created_at)))
    return {**snapshot(run), "plan": serialize_plan(plan, db), "events": [snapshot(e) for e in events],
            "audit_logs": [snapshot(a) for a in audits]}


@router.get("/plans/{plan_id}")
def read_plan(plan_id: str, db: Session = Depends(get_db, scope="function")):
    return serialize_plan(get_plan(db, get_actor(db), plan_id), db)


@router.patch("/plans/{plan_id}")
def update_plan(plan_id: str, body: PlanEdit, db: Session = Depends(get_db, scope="function")):
    return serialize_plan(edit_plan(db, get_actor(db), plan_id, body), db)


def metadata_run(db, run_id):
    return db.scalar(select(IngestionJob.id).where(IngestionJob.kind == "organize",
        IngestionJob.payload["run_id"].as_string() == run_id)) is not None


@router.post("/plans/{plan_id}/approve")
def approve_plan(plan_id: str, body: ApproveRequest, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    plan = get_plan(db, actor, plan_id)
    if metadata_run(db, plan.run_id):
        return execute_plan(db, actor, plan_id, body.plan_version, body.confirm_high_risk)
    return resume_plan(db, actor, plan_id, {"action": "approve", **body.model_dump()})


@router.post("/plans/{plan_id}/reject")
def reject(plan_id: str, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    plan = get_plan(db, actor, plan_id)
    if metadata_run(db, plan.run_id):
        return snapshot(reject_plan(db, actor, plan_id))
    return resume_plan(db, actor, plan_id, {"action": "reject"})


@router.post("/runs/{run_id}/undo")
def undo(run_id: str, db: Session = Depends(get_db, scope="function")):
    return undo_run(db, get_actor(db), run_id)


@router.get("/runs/{run_id}/events")
def events(run_id: str, after: int = Query(0, ge=0), last_event_id: str | None = Header(None),
           db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    get_run(db, actor, run_id)
    try:
        cursor = max(after, int(last_event_id or "0"))
    except ValueError as exc:
        raise AppError("invalid_cursor", "事件游标必须是非负整数") from exc
    bind, actor_id = db.get_bind(), actor.id

    def stream():
        nonlocal cursor
        for _ in range(240):
            with Session(bind=bind) as event_db:
                # Permissions are checked for every poll, including after a library is trashed.
                current_actor = get_actor(event_db)
                if current_actor.id != actor_id:
                    break
                try:
                    run = get_run(event_db, current_actor, run_id)
                except AppError:
                    yield "event: error\ndata: {\"message\":\"知识库权限已变化\"}\n\n"
                    return
                rows = list(event_db.scalars(select(AgentEvent).where(AgentEvent.run_id == run.id,
                    AgentEvent.sequence > cursor).order_by(AgentEvent.sequence)))
                for event in rows:
                    cursor = event.sequence
                    payload = {"sequence": event.sequence, "timestamp": event.created_at.isoformat(), **event.data}
                    yield f"id: {cursor}\nevent: {event.type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                if run.status in {"pending_review", "completed", "rejected", "undone", "failed", "cancelled"}:
                    return
            yield ": keepalive\n\n"
            time.sleep(0.5)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
