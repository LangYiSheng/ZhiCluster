"""Durable Plan -> Review -> Execute -> Verify orchestration.

Business snapshots/undo live in SQLAlchemy tables. LangGraph checkpoints only
track workflow progress and never replace the business transaction or its audit.
"""

from contextlib import contextmanager
from typing import TypedDict
from uuid import UUID

import psycopg
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from psycopg.conninfo import make_conninfo
from sqlalchemy import select
from sqlalchemy.engine import make_url

from app.agent.executor import emit_event, execute_plan, get_plan, get_run, persist_plan, reject_plan
from app.agent.planner import plan_with_model
from app.core.config import get_settings
from app.core.errors import AppError
from app.db.models import AgentPlan, IngestionJob
from app.services.permissions import get_actor
from app.services.runtime_config import get_runtime_settings


class WorkflowState(TypedDict, total=False):
    run_id: str
    plan_id: str
    status: str
    decision: dict
    result: dict


class AgentJobStopped(AppError):
    def __init__(self, cancelled=False):
        super().__init__("agent_cancelled" if cancelled else "agent_lease_lost",
                         "整理任务已取消" if cancelled else "整理任务租约已移交", 409)


def checkpoint_conninfo(database_url: str) -> str:
    url = make_url(database_url)
    if url.get_backend_name() != "postgresql":
        raise AppError("postgres_required", "Agent 持久审批需要 PostgreSQL checkpoint，请启动 Compose 数据库", 503)
    url = url.set(drivername="postgresql")
    return make_conninfo(url.render_as_string(hide_password=False), options="-c search_path=agent_checkpoints,public")


def setup_checkpointer(database_url=None):
    database_url = database_url or get_settings().database_url
    base = make_url(database_url).set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(base, autocommit=True) as connection:
        connection.execute("CREATE SCHEMA IF NOT EXISTS agent_checkpoints")
    with PostgresSaver.from_conn_string(checkpoint_conninfo(database_url)) as saver:
        saver.setup()


@contextmanager
def checkpointer(database_url=None):
    with PostgresSaver.from_conn_string(checkpoint_conninfo(database_url or get_settings().database_url)) as saver:
        yield saver


@contextmanager
def workflow_lock(run_id, database_url=None):
    """Fence concurrent workers/approvals before they write the same graph thread."""
    lock_id = int.from_bytes(UUID(run_id).bytes[:8], "big", signed=True)
    with psycopg.connect(checkpoint_conninfo(database_url or get_settings().database_url), autocommit=True) as connection:
        connection.execute("SELECT pg_advisory_lock(%s)", (lock_id,))
        try:
            yield
        finally:
            connection.execute("SELECT pg_advisory_unlock(%s)", (lock_id,))


def build_graph(saver, plan_callback, execute_callback, reject_callback, verify_callback):
    """Callbacks keep I/O testable without granting tools any write capability."""
    def plan(state: WorkflowState):
        plan_id = plan_callback(state["run_id"])
        return {"plan_id": plan_id, "status": "pending_review"}

    def review(state: WorkflowState):
        decision = interrupt({"plan_id": state["plan_id"], "message": "请审阅完整计划后一次批准或拒绝"})
        if not isinstance(decision, dict) or decision.get("action") not in {"approve", "reject"}:
            raise AppError("invalid_decision", "审批决定无效")
        if decision["action"] == "reject":
            reject_callback(state["plan_id"])
            return {"decision": decision, "status": "rejected"}
        return {"decision": decision, "status": "approved"}

    def execute(state: WorkflowState):
        result = execute_callback(state["plan_id"], state["decision"])
        return {"status": "completed", "result": result}

    def verify(state: WorkflowState):
        verify_callback(state["run_id"])
        return {"status": "completed"}

    builder = StateGraph(WorkflowState)
    builder.add_node("plan", plan)
    builder.add_node("review", review)
    builder.add_node("execute", execute)
    builder.add_node("verify", verify)
    builder.add_edge(START, "plan")
    builder.add_edge("plan", "review")
    builder.add_conditional_edges("review", lambda state: "execute" if state["status"] == "approved" else END)
    builder.add_edge("execute", "verify")
    builder.add_edge("verify", END)
    return builder.compile(checkpointer=saver)


def database_graph(db, saver, planner=None, guard=None, on_pending=None, settings=None):
    actor = get_actor(db)
    if planner is None:
        settings = settings or get_runtime_settings(db, get_settings())

        def planner(*args, **kwargs):
            return plan_with_model(*args, settings=settings, **kwargs)
    guard = guard or (lambda: None)

    def plan_callback(run_id):
        guard()
        run = get_run(db, actor, run_id)
        if run.status == "cancelled":
            raise AgentJobStopped(cancelled=True)
        existing = db.scalar(select(AgentPlan).where(AgentPlan.run_id == run.id))
        if existing:
            if on_pending:
                on_pending(existing)
            db.commit()
            return existing.id
        observed = {}
        policy, source, source_versions = None, None, {}
        job = db.scalar(select(IngestionJob).where(IngestionJob.kind == "agent",
            IngestionJob.payload["run_id"].as_string() == run.id).order_by(IngestionJob.created_at.desc()).limit(1))
        if job and job.payload.get("mode"):
            from app.agent.organization import source_snapshot
            from app.agent.organization_policy import policy_from_source

            source, source_versions = source_snapshot(db, actor, run.kb_id, job.payload.get("document_ids"))
            policy = policy_from_source(job.payload["mode"], source, job.payload.get("cleanup_empty_folders", True))
        # Do not hold the job lease row lock across a model/network call.
        db.commit()

        def emit(event_type, data):
            guard()
            emit_event(db, run.id, event_type, data)
            db.commit()

        draft = planner(db, actor, run.kb_id, run.goal, emit, observed,
            **({"organization_mode": policy.mode, "document_ids": policy.document_ids} if policy else {}))
        if policy:
            from app.agent.organization_policy import append_cleanup

            draft = append_cleanup(draft, source, policy)
        guard()
        plan = persist_plan(db, actor, run, draft, {**observed, **source_versions}, organization=policy)
        if on_pending:
            on_pending(plan)
        db.commit()
        return plan.id

    def execute_callback(plan_id, decision):
        try:
            result = execute_plan(db, actor, plan_id, decision["plan_version"], decision.get("confirm_high_risk", False))
            db.commit()
            return result
        except Exception:
            db.rollback()
            raise

    def reject_callback(plan_id):
        reject_plan(db, actor, plan_id)
        db.commit()

    def verify_callback(run_id):
        run = get_run(db, actor, run_id)
        if run.status != "completed":
            raise AppError("verification_failed", "整理事务状态未完成，请重新获取任务状态", 409)

    return build_graph(saver, plan_callback, execute_callback, reject_callback, verify_callback)


def process_agent_run(db, run_id, job_id=None, owner=None, planner=None, settings=None):
    actor = get_actor(db)

    def guard():
        if not job_id:
            return None
        job = db.scalar(select(IngestionJob).where(IngestionJob.id == job_id).with_for_update().execution_options(populate_existing=True))
        if job and job.status == "cancelled":
            raise AgentJobStopped(cancelled=True)
        if not job or job.kind != "agent" or job.payload.get("run_id") != run_id or job.status != "running" or (owner and job.lease_owner != owner):
            raise AgentJobStopped()
        return job

    def finish_pending(_plan=None):
        job = guard()
        if job:
            from app.worker.queue import emit

            # Atomic with persist_plan: a pending plan never has a cancellable running job.
            job.status, job.stage, job.progress = "completed", "completed", 100
            job.lease_owner, job.lease_until = None, None
            emit(db, job, "completed", {"run_id": run_id})

    def stop(stopped):
        db.rollback()
        if stopped.code != "agent_cancelled":
            return
        if job_id:
            job = db.scalar(select(IngestionJob).where(IngestionJob.id == job_id).with_for_update().execution_options(populate_existing=True))
            if not job or job.status != "cancelled":
                return  # A later explicit retry/new lease must not be overwritten.
            if not owner or job.lease_owner == owner:
                job.lease_owner, job.lease_until = None, None
        run = get_run(db, actor, run_id, lock=True)
        if run.status != "cancelled":
            run.status, run.error = "cancelled", "整理任务已取消"
            emit_event(db, run.id, "completed", {"message": run.error, "status": "cancelled"})
        db.commit()

    try:
        guard()
        run = get_run(db, actor, run_id, lock=True)
        if run.status in {"pending_review", "completed", "rejected", "undone"}:
            finish_pending()
            db.commit()
            return
        if run.status == "cancelled":
            raise AgentJobStopped(cancelled=True)
        run.status, run.error = "planning", None
        db.commit()
        with workflow_lock(run.id):
            guard()
            run = get_run(db, actor, run_id)
            if run.status in {"pending_review", "completed", "rejected", "undone"}:
                finish_pending()
                db.commit()
                return
            db.commit()
            with checkpointer() as saver:
                graph = database_graph(db, saver, planner=planner, guard=guard, on_pending=finish_pending, settings=settings)
                graph.invoke({"run_id": run.id}, {"configurable": {"thread_id": run.thread_id}})
    except AgentJobStopped as stopped:
        stop(stopped)
        return
    except Exception as exc:
        db.rollback()
        # A failed or delayed old worker cannot mark its successor's run as failed.
        try:
            guard()
        except AgentJobStopped as stopped:
            stop(stopped)
            return
        run = get_run(db, actor, run_id, lock=True)
        if run.status in {"pending_review", "completed", "rejected", "undone"}:
            # A durable business plan remains usable even if its last checkpoint write failed.
            db.commit()
            return
        run.status = "failed"
        run.error = exc.message if isinstance(exc, AppError) else "整理规划失败，请检查 PostgreSQL checkpoint 和模型服务"
        emit_event(db, run.id, "error", {"message": run.error,
                    "code": exc.code if isinstance(exc, AppError) else "agent_failed"})
        db.commit()
        raise AppError("agent_failed", run.error, 502) from None


def resume_plan(db, actor, plan_id, decision):
    plan = get_plan(db, actor, plan_id)
    run = get_run(db, actor, plan.run_id)
    if run.status == "cancelled":
        raise AppError("invalid_run_state", "已取消的整理任务不能批准执行", 409)
    if decision.get("action") == "approve" and plan.status == "completed":
        return execute_plan(db, actor, plan.id, decision["plan_version"], decision.get("confirm_high_risk", False))
    if decision.get("action") == "reject" and plan.status == "rejected":
        return {"status": "rejected"}
    # Fail preflight before consuming an interrupt. Failed approval may then be edited/retried.
    from app.agent.executor import check_versions, validate_parameters
    from app.agent.plans import AgentPlanData
    from app.services.library import version_check

    if plan.status != "pending_review":
        raise AppError("invalid_plan_state", "此计划不在待审批状态", 409)
    if decision["action"] == "approve":
        version_check(plan, decision.get("plan_version"))
        data = AgentPlanData.model_validate(plan.payload)
        check_versions(db, data, lock=False)
        validate_parameters(db, data)
        if data.risk_level == "high" and not decision.get("confirm_high_risk"):
            raise AppError("high_risk_confirmation_required", "计划包含软删除，请额外确认影响数量", 409)
    db.commit()
    with workflow_lock(run.id):
        # Another approval may have finished while this request waited for its thread.
        plan = get_plan(db, actor, plan_id)
        if decision["action"] == "approve" and plan.status == "completed":
            return execute_plan(db, actor, plan.id, decision["plan_version"], decision.get("confirm_high_risk", False))
        if decision["action"] == "reject" and plan.status == "rejected":
            return {"status": "rejected"}
        with checkpointer() as saver:
            graph = database_graph(db, saver)
            config = {"configurable": {"thread_id": run.thread_id}}
            snapshot = graph.get_state(config)
            if not snapshot.values:
                # A pending business plan can recreate its review checkpoint after restore.
                graph.invoke({"run_id": run.id}, config)
            elif snapshot.next not in {( "execute",), ()} and not any(task.interrupts for task in snapshot.tasks):
                # Recover a crash after the business plan commit but before interrupt commit.
                graph.invoke(None, config)
            snapshot = graph.get_state(config)
            if snapshot.next == ("execute",):
                # A failed transaction must accept the newly reviewed version on retry.
                graph.update_state(config, {"decision": decision, "status": "approved"}, as_node="review")
                result = graph.invoke(None, config)
            else:
                result = graph.invoke(Command(resume=decision), config)
    return result.get("result", {"status": result.get("status", "pending_review")})


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--setup", action="store_true")
    args = parser.parse_args()
    if args.setup:
        setup_checkpointer()
        print("PostgreSQL Agent checkpoint schema initialized")
