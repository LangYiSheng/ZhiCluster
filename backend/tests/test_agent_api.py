"""HTTP contract and replay tests without any live model service."""

from types import SimpleNamespace

from sqlalchemy import select

from app.agent.executor import persist_plan
from app.agent.plans import PlanDraft
from app.db.models import AgentRun, Document, KnowledgeBase, new_id
from app.services.permissions import get_actor


def saved_plan(factory):
    with factory() as db:
        actor = get_actor(db)
        kb = db.scalar(select(KnowledgeBase).where(KnowledgeBase.owner_id == actor.id))
        document = Document(kb_id=kb.id, owner_id=actor.id, display_name="真实文件.md", original_filename="真实文件.md",
            mime_type="text/markdown", ext="md", sha256="b" * 64, size_bytes=20, storage_key=f"tests/{new_id()}/original")
        run = AgentRun(kb_id=kb.id, actor_id=actor.id, thread_id=new_id(), goal="整理资料")
        db.add_all([document, run])
        db.flush()
        plan = persist_plan(db, actor, run, PlanDraft(summary="文件改名", operations=[{
            "operation_id": "rename", "type": "rename_document", "target_ids": [document.id],
            "description": "重命名文件", "params": {"name": "模型提出的文件名.md"},
        }]))
        db.commit()
        return run.id, plan.id, document.id, kb.id


def test_agent_http_read_edit_and_event_cursor_replay(client, factory):
    run_id, plan_id, document_id, kb_id = saved_plan(factory)
    response = client.get(f"/api/agent/runs/{run_id}")
    assert response.status_code == 200
    assert response.json()["status"] == "pending_review"
    assert response.json()["plan"]["id"] == plan_id
    assert len(client.get("/api/agent/runs", params={"kb_id": kb_id}).json()) == 1
    operations = response.json()["plan"]["payload"]["operations"]
    operations[0]["params"] = {"name": "用户调整的文件名.md"}
    edited = client.patch(f"/api/agent/plans/{plan_id}", json={"version": 1, "operations": operations})
    assert edited.status_code == 200 and edited.json()["version"] == 2
    with factory() as db:
        assert db.get(Document, document_id).display_name == "真实文件.md"
    stale = client.patch(f"/api/agent/plans/{plan_id}", json={"version": 1, "operations": operations})
    assert stale.status_code == 409 and stale.json()["code"] == "version_conflict"
    events = client.get(f"/api/agent/runs/{run_id}/events")
    assert events.status_code == 200
    assert "event: plan_ready" in events.text
    assert "event: approval_required" in events.text
    assert '"sequence": 1' in events.text and '"timestamp"' in events.text
    replay = client.get(f"/api/agent/runs/{run_id}/events", headers={"Last-Event-ID": "2"})
    assert "event: plan_ready" not in replay.text
    assert "event: approval_required" not in replay.text
    assert "event: status" in replay.text  # The edited-plan event was persisted as sequence 3.
    invalid_cursor = client.get(f"/api/agent/runs/{run_id}/events", headers={"Last-Event-ID": "invalid"})
    assert invalid_cursor.status_code == 400


def test_agent_missing_key_is_explicit_and_never_creates_fake_run(client, factory, monkeypatch):
    import app.api.agent as api

    monkeypatch.setattr(api, "get_settings", lambda: SimpleNamespace(llm_configured=False))
    with factory() as db:
        kb_id = db.scalar(select(KnowledgeBase.id))
    response = client.post("/api/agent/runs", json={"kb_id": kb_id, "goal": "整理知识库"})
    assert response.status_code == 503
    assert response.json()["code"] == "model_not_configured"
    assert client.get("/api/agent/runs", params={"kb_id": kb_id}).json() == []


def test_agent_cancelled_run_cannot_be_approved_and_retry_without_plan_requeues(client, factory):
    from app.db.models import IngestionJob

    run_id, plan_id, document_id, kb_id = saved_plan(factory)
    with factory() as db:
        run = db.get(AgentRun, run_id)
        run.status = "planning"
        job = IngestionJob(kb_id=kb_id, kind="agent", status="running", lease_owner="worker",
                           payload={"run_id": run_id})
        db.add(job)
        db.commit()
        job_id = job.id
    assert client.post(f"/api/ingestion/jobs/{job_id}/cancel").status_code == 200
    assert client.get(f"/api/agent/runs/{run_id}").json()["status"] == "cancelled"
    rejected = client.post(f"/api/agent/plans/{plan_id}/approve", json={"plan_version": 1})
    assert rejected.status_code == 409 and rejected.json()["code"] == "invalid_run_state"
    with factory() as db:
        assert db.get(Document, document_id).display_name == "真实文件.md"
    assert client.post(f"/api/ingestion/jobs/{job_id}/retry").status_code == 409

    with factory() as db:
        run = AgentRun(kb_id=kb_id, actor_id=get_actor(db).id, thread_id=new_id(), goal="可重试取消任务", status="cancelled")
        db.add(run)
        db.flush()
        job = IngestionJob(kb_id=kb_id, kind="agent", status="cancelled", payload={"run_id": run.id})
        db.add(job)
        db.commit()
        job_id, run_id = job.id, run.id
    assert client.post(f"/api/ingestion/jobs/{job_id}/retry").status_code == 200
    assert client.get(f"/api/agent/runs/{run_id}").json()["status"] == "queued"
