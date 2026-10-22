"""Opt-in PostgreSQL checks; fake planning is explicitly separate from live AI."""

import json
import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

import app.agent.graph as workflow
from app.agent.executor import edit_plan, persist_plan
from app.agent.plans import PlanDraft, PlanEdit
from app.core.config import Settings
from app.db.models import (
    AgentPlan,
    AgentRun,
    AuditLog,
    Document,
    IngestionJob,
    KnowledgeBase,
    KnowledgeBaseMember,
    UndoRecord,
    new_id,
)
from app.db.seed import seed
from app.services.permissions import get_actor

TEST_URL = os.getenv("ZHICLUSTER_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="set ZHICLUSTER_TEST_DATABASE_URL to an isolated migrated PostgreSQL database")


@pytest.fixture
def pg_workspace(monkeypatch):
    engine = create_engine(TEST_URL, pool_pre_ping=True)
    sessions = sessionmaker(engine, expire_on_commit=False)
    settings = Settings(database_url=TEST_URL, app_env="test")
    monkeypatch.setattr(workflow, "get_settings", lambda: settings)
    with sessions() as db:
        seed(db)
        actor = get_actor(db)
        kb = KnowledgeBase(owner_id=actor.id, name=f"Agent PG 验证 {new_id()[:8]}")
        db.add(kb)
        db.flush()
        db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
        document = Document(kb_id=kb.id, owner_id=actor.id, display_name="原始论文.md", original_filename="原始论文.md",
            mime_type="text/markdown", ext="md", sha256="a" * 64, size_bytes=10,
            storage_key=f"agent-tests/{new_id()}/original", parse_status="completed", index_status="unconfigured")
        db.add(document)
        run = AgentRun(kb_id=kb.id, actor_id=actor.id, thread_id=new_id(), goal="整理未分类论文")
        db.add(run)
        db.commit()
        ids = {"run_id": run.id, "doc_id": document.id, "thread_id": run.thread_id, "kb_id": kb.id}
    yield sessions, ids
    engine.dispose()


def draft_for(document_id):
    return PlanDraft(summary="真实数据库审批测试", operations=[{"operation_id": "rename", "type": "rename_document",
        "target_ids": [document_id], "params": {"name": "模型原始方案.md"}, "description": "重命名论文"}])


def pending_checkpoint(sessions, ids):
    with sessions() as db:
        with workflow.checkpointer() as saver:
            graph = workflow.database_graph(db, saver, planner=lambda *_: draft_for(ids["doc_id"]))
            result = graph.invoke({"run_id": ids["run_id"]}, {"configurable": {"thread_id": ids["thread_id"]}})
            assert result["__interrupt__"]
        plan = db.scalar(select(AgentPlan).where(AgentPlan.run_id == ids["run_id"]))
        assert db.get(Document, ids["doc_id"]).display_name == "原始论文.md"
        return plan.id


def test_postgres_saver_setup_is_idempotent_and_uses_dedicated_schema(pg_workspace):
    sessions, _ = pg_workspace
    workflow.setup_checkpointer(TEST_URL)
    workflow.setup_checkpointer(TEST_URL)
    with sessions() as db:
        tables = set(db.scalars(text("SELECT table_name FROM information_schema.tables WHERE table_schema='agent_checkpoints'")))
        assert {"checkpoints", "checkpoint_blobs", "checkpoint_writes", "checkpoint_migrations"} <= tables


def test_postgres_pending_plan_survives_new_process_and_uses_edited_plan(pg_workspace):
    sessions, ids = pg_workspace
    plan_id = pending_checkpoint(sessions, ids)
    with sessions() as db:
        plan = db.get(AgentPlan, plan_id)
        operations = [{**plan.payload["operations"][0], "params": {"name": "用户编辑后的最终方案.md"}}]
        edit_plan(db, get_actor(db), plan.id, PlanEdit(version=1, operations=operations))
        db.commit()
    code = """
import json,sys
from app.agent.graph import resume_plan
from app.db.session import SessionLocal
from app.services.permissions import get_actor
with SessionLocal() as db:
    result=resume_plan(db,get_actor(db),sys.argv[1],{'action':'approve','plan_version':2,'confirm_high_risk':False})
    db.commit()
    print(json.dumps(result))
"""
    env = {**os.environ, "DATABASE_URL": TEST_URL, "APP_ENV": "test", "PYTHONIOENCODING": "utf-8"}
    completed = subprocess.run([sys.executable, "-c", code, plan_id], env=env, capture_output=True,
                               text=True, encoding="utf-8", timeout=60, check=True)
    assert json.loads(completed.stdout)["operations"][0]["status"] == "completed"
    with sessions() as db:
        assert db.get(Document, ids["doc_id"]).display_name == "用户编辑后的最终方案.md"
        assert db.get(AgentRun, ids["run_id"]).status == "completed"
        assert db.scalar(select(func.count()).select_from(UndoRecord).where(UndoRecord.run_id == ids["run_id"])) == 1


def test_postgres_concurrent_approval_has_one_business_execution(pg_workspace):
    sessions, ids = pg_workspace
    plan_id = pending_checkpoint(sessions, ids)
    barrier = threading.Barrier(2)

    def approve():
        with sessions() as db:
            # Populate both identity maps before either thread takes the plan lock.
            db.get(AgentPlan, plan_id)
            actor = get_actor(db)
            barrier.wait(timeout=15)
            result = workflow.resume_plan(db, actor, plan_id, {"action": "approve", "plan_version": 1})
            db.commit()
            return result

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(approve) for _ in range(2)]
        results = [future.result(timeout=60) for future in futures]
    assert results[0] == results[1]
    with sessions() as db:
        assert db.get(Document, ids["doc_id"]).version == 2
        assert db.scalar(select(func.count()).select_from(UndoRecord).where(UndoRecord.run_id == ids["run_id"])) == 1
        assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.run_id == ids["run_id"], AuditLog.action == "rename_document")) == 1


def test_postgres_undo_is_atomic_on_late_conflict(pg_workspace):
    from app.agent.executor import execute_plan, undo_run
    from app.core.errors import AppError
    from app.services.library import update_document

    sessions, ids = pg_workspace
    with sessions() as db:
        actor = get_actor(db)
        run = db.get(AgentRun, ids["run_id"])
        plan = persist_plan(db, actor, run, draft_for(ids["doc_id"]))
        execute_plan(db, actor, plan.id, 1)
        db.commit()
        update_document(db, actor, ids["doc_id"], {"display_name": "后续人工工作.md"})
        db.commit()
        with pytest.raises(AppError) as exc:
            undo_run(db, actor, run.id)
        assert exc.value.code == "undo_conflict"
        db.rollback()
        assert db.get(Document, ids["doc_id"]).display_name == "后续人工工作.md"
        assert db.get(AgentRun, ids["run_id"]).status == "completed"


def test_postgres_concurrent_folder_moves_cannot_form_cycle(pg_workspace):
    from app.core.errors import AppError
    from app.services.library import create_folder, update_folder

    sessions, ids = pg_workspace
    with sessions() as db:
        actor = get_actor(db)
        first = create_folder(db, actor, ids["kb_id"], {"name": "A"})
        second = create_folder(db, actor, ids["kb_id"], {"name": "B"})
        db.commit()
        first_id, second_id = first.id, second.id
    barrier = threading.Barrier(2)

    def move(source, destination):
        with sessions() as db:
            actor = get_actor(db)
            barrier.wait(timeout=15)
            try:
                update_folder(db, actor, source, {"parent_id": destination})
                db.commit()
                return "moved"
            except AppError as exc:
                db.rollback()
                return exc.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda pair: move(*pair), [(first_id, second_id), (second_id, first_id)]))
    assert sorted(results) == ["folder_cycle", "moved"]


def queued_agent_job(sessions, ids, owner="old-worker"):
    with sessions() as db:
        job = IngestionJob(kb_id=ids["kb_id"], kind="agent", status="running", lease_owner=owner,
                           payload={"run_id": ids["run_id"]})
        db.add(job)
        db.commit()
        return job.id


def test_postgres_cancel_during_planning_never_saves_pending_plan(pg_workspace):
    from app.api.workflows import cancel_job
    from app.core.errors import AppError

    sessions, ids = pg_workspace
    job_id = queued_agent_job(sessions, ids)
    started, release = threading.Event(), threading.Event()

    def controlled_planner(*_):
        started.set()
        assert release.wait(timeout=20)
        return draft_for(ids["doc_id"])

    def worker():
        with sessions() as db:
            workflow.process_agent_run(db, ids["run_id"], job_id=job_id, owner="old-worker", planner=controlled_planner)

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(worker)
        try:
            assert started.wait(timeout=15)
            with sessions() as db:
                cancel_job(job_id, db)
                db.commit()
        finally:
            release.set()
        future.result(timeout=30)
    with sessions() as db:
        run = db.get(AgentRun, ids["run_id"])
        assert run.status == "cancelled"
        assert db.get(IngestionJob, job_id).status == "cancelled"
        assert db.scalar(select(AgentPlan.id).where(AgentPlan.run_id == run.id)) is None
        assert db.get(Document, ids["doc_id"]).display_name == "原始论文.md"
        assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.run_id == run.id)) == 0
        with pytest.raises(AppError) as exc:
            persist_plan(db, get_actor(db), run, draft_for(ids["doc_id"]))
        assert exc.value.code == "invalid_run_state"
        with pytest.raises(AppError) as exc:
            workflow.resume_plan(db, get_actor(db), new_id(), {"action": "approve", "plan_version": 1})
        assert exc.value.status == 404


@pytest.mark.parametrize("old_result", ["returns", "event", "fails"])
def test_postgres_transferred_agent_lease_fences_stale_plan_event_and_error(pg_workspace, old_result):
    from app.core.errors import AppError

    sessions, ids = pg_workspace
    job_id = queued_agent_job(sessions, ids)
    started, release = threading.Event(), threading.Event()

    def controlled_planner(db, actor, kb_id, goal, emit, observed):
        started.set()
        assert release.wait(timeout=20)
        if old_result == "event":
            emit("status", {"message": "STALE_EVENT_MUST_NOT_PERSIST"})
        if old_result == "fails":
            raise AppError("model_error", "过期 worker 的模型错误", 502)
        return draft_for(ids["doc_id"])

    def old_worker():
        with sessions() as db:
            workflow.process_agent_run(db, ids["run_id"], job_id=job_id, owner="old-worker", planner=controlled_planner)

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(old_worker)
        try:
            assert started.wait(timeout=15)
            with sessions() as db:
                job = db.get(IngestionJob, job_id)
                job.lease_owner = "new-worker"
                db.commit()
        finally:
            release.set()
        future.result(timeout=30)
    with sessions() as db:
        assert db.get(IngestionJob, job_id).lease_owner == "new-worker"
        assert db.get(IngestionJob, job_id).status == "running"
        assert db.get(AgentRun, ids["run_id"]).status == "planning"
        assert db.scalar(select(AgentPlan.id).where(AgentPlan.run_id == ids["run_id"])) is None
        from app.db.models import AgentEvent

        assert all("STALE_EVENT" not in str(event.data) for event in db.scalars(select(AgentEvent).where(AgentEvent.run_id == ids["run_id"])))
        workflow.process_agent_run(db, ids["run_id"], job_id=job_id, owner="new-worker", planner=lambda *_: draft_for(ids["doc_id"]))
    with sessions() as db:
        assert db.get(IngestionJob, job_id).status == "completed"
        assert db.get(AgentRun, ids["run_id"]).status == "pending_review"
        assert db.scalar(select(func.count()).select_from(AgentPlan).where(AgentPlan.run_id == ids["run_id"])) == 1
