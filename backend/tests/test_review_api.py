"""Review approvals and JSON organization with isolated, controlled model data."""

import json

import httpx
import pytest
from sqlalchemy import delete, func, select

from app.agent.organization import process_organization_job
from app.ai.gateway import ModelGateway
from app.core.config import Settings
from app.db.models import (
    AgentPlan,
    AgentRun,
    AuditLog,
    ClassificationSuggestion,
    Document,
    DocumentTag,
    Folder,
    IngestionJob,
    JobEvent,
    KnowledgeBaseMember,
    Tag,
    new_id,
)
from app.services.library import update_document
from app.services.permissions import get_actor


def create_source(db, kb_id, name="真实资料.md", payload=None):
    actor = get_actor(db)
    doc = Document(kb_id=kb_id, owner_id=actor.id, display_name=name, original_filename=name,
        ext="md", mime_type="text/markdown", sha256="a" * 64, size_bytes=20,
        storage_key=f"tests/{new_id()}/original", parse_status="ready", summary_status="ready", short_summary="测试资料的真实摘要")
    db.add(doc)
    db.flush()
    suggestion = ClassificationSuggestion(kb_id=kb_id, document_id=doc.id, document_version=doc.version,
        payload=payload or {"existing_folder_id": None, "proposed_folder_path": "主题/研究", "existing_tag_ids": [],
                            "new_tag_names": ["研究"], "short_summary": "摘要", "reason": "按实际主题分类"})
    db.add(suggestion)
    db.flush()
    return doc, suggestion


def configured():
    return Settings(llm_base_url="https://controlled-model.test/v1", llm_api_key="controlled-test-key",
                    llm_model="json-only", llm_supports_tools=False)


def test_review_page_filters_versions_paths_and_document_scope(client, factory):
    first = client.get("/api/knowledge-bases").json()[0]["id"]
    second = client.post("/api/knowledge-bases", json={"name": "第二库"}).json()["id"]
    with factory() as db:
        doc, pending = create_source(db, first)
        other, _ = create_source(db, second, "第二份.md")
        doc.version += 1
        db.commit()
        doc_id, suggestion_id = doc.id, pending.id
    page = client.get("/api/review/suggestions", params={"page_size": 1}).json()
    assert page["total"] == 2 and len(page["items"]) == 1 and page["counts"]["pending"] == 2
    selected = client.get("/api/review/suggestions", params={"kb_id": first, "document_id": doc_id}).json()
    item = selected["items"][0]
    assert item["id"] == suggestion_id and item["conflict"]
    assert item["current_folder_path"] == "知识库根目录" and item["target_folder_path"] == "主题/研究"
    assert item["can_edit"] and item["document_available"]
    wrong = client.get("/api/review/suggestions", params={"kb_id": second, "document_id": doc_id})
    assert wrong.status_code == 400 and wrong.json()["code"] == "scope_mismatch"


def test_single_apply_has_audited_plan_and_conflict_safe_undo(client, factory):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    with factory() as db:
        doc, suggestion = create_source(db, kb_id)
        db.commit()
        doc_id, suggestion_id, version = doc.id, suggestion.id, doc.version
    approved = client.post(f"/api/review/suggestions/{suggestion_id}", json={"action": "apply", "document_version": version})
    assert approved.status_code == 200, approved.text
    run_id = approved.json()["run_id"]
    with factory() as db:
        doc = db.get(Document, doc_id)
        assert db.get(Folder, doc.folder_id).name == "研究"
        assert db.scalar(select(Tag.name).join(DocumentTag, DocumentTag.tag_id == Tag.id).where(DocumentTag.document_id == doc_id)) == "研究"
        assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.run_id == run_id)) >= 3
    repeated = client.post(f"/api/review/suggestions/{suggestion_id}", json={"action": "apply", "document_version": version})
    assert repeated.status_code == 409 and repeated.json()["code"] == "not_pending"
    assert client.post(f"/api/agent/runs/{run_id}/undo").status_code == 200
    with factory() as db:
        assert db.get(Document, doc_id).folder_id is None
        assert db.scalar(select(func.count()).select_from(DocumentTag).where(DocumentTag.document_id == doc_id)) == 0


def test_batch_reports_each_conflict_and_foreign_reference_without_ghost_runs(client, factory):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    other = client.post("/api/knowledge-bases", json={"name": "其他库"}).json()["id"]
    foreign_tag = client.post(f"/api/knowledge-bases/{other}/tags", json={"name": "不能跨库"}).json()["id"]
    with factory() as db:
        stale_doc, stale = create_source(db, kb_id, "旧版本.md")
        _, valid = create_source(db, kb_id, "有效.md")
        _, foreign = create_source(db, kb_id, "非法.md", {"existing_folder_id": None,
            "existing_tag_ids": [foreign_tag], "new_tag_names": [], "short_summary": "", "reason": "错误跨库"})
        stale_doc.version += 1
        db.commit()
        identifiers = [stale.id, valid.id, foreign.id]
    response = client.post("/api/review/suggestions/batch", json={"action": "apply", "items": [
        {"suggestion_id": item, "document_version": 1} for item in identifiers]})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["succeeded"] == 1 and data["failed"] == 2
    assert [item["status"] for item in data["items"]] == ["conflict", "applied", "conflict"]
    assert data["items"][0]["code"] == "version_conflict"
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(AgentRun)) == 1
        assert db.get(ClassificationSuggestion, identifiers[2]).status == "pending"
    # Rejecting an obsolete suggestion is allowed: it does not overwrite a document.
    rejected = client.post(f"/api/review/suggestions/{identifiers[0]}", json={"action": "reject", "document_version": 1})
    assert rejected.status_code == 200 and rejected.json()["status"] == "rejected"


def enqueue_plan(client, factory, monkeypatch):
    import app.api.review as api

    monkeypatch.setattr(api, "get_runtime_settings", lambda *_: configured())
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    with factory() as db:
        doc, _ = create_source(db, kb_id)
        db.commit()
        doc_id = doc.id
    created = client.post("/api/review/plans", json={"kb_id": kb_id})
    assert created.status_code == 201, created.text
    run_id = created.json()["id"]
    with factory() as db:
        job = db.scalar(select(IngestionJob).where(IngestionJob.kind == "organize"))
        job.status, job.lease_owner = "running", "worker"
        db.commit()
        job_id = job.id
    return kb_id, doc_id, run_id, job_id


def test_json_organization_waits_for_review_supports_edit_selection_and_undo(client, factory, monkeypatch):
    kb_id, doc_id, run_id, job_id = enqueue_plan(client, factory, monkeypatch)
    calls = []

    class Gateway:
        llm_configured = True

        def chat(self, messages, **options):
            calls.append((messages, options))
            data = json.loads(messages[1]["content"])
            assert data["documents"][0]["id"] == "D1" and doc_id not in messages[1]["content"]
            return json.dumps({"summary": "归入研究主题", "folders": [{"ref": "research", "name": "研究", "parent_id": None}],
                "documents": [{"document_id": "D1", "folder_id": "ref:research", "existing_tag_ids": [], "new_tag_names": ["研究"], "reason": "资料主题一致"}]})

    process_organization_job(job_id, factory, configured(), owner="worker", gateway=Gateway())
    assert len(calls) == 1 and calls[0][1]["json_mode"] is True
    with factory() as db:
        assert db.get(Document, doc_id).folder_id is None
        assert db.scalar(select(func.count()).select_from(Folder)) == 0
        assert db.get(AgentRun, run_id).status == "pending_review"
        assert db.get(IngestionJob, job_id).status == "completed"
        events = list(db.scalars(select(JobEvent).where(JobEvent.job_id == job_id).order_by(JobEvent.sequence)))
        assert [event.data["stage"] for event in events if event.type == "progress"] == ["snapshot", "planning", "validating"]
        assert all(event.data.get("progress", 0) == 0 for event in events if event.type == "progress")
    detail = client.get(f"/api/agent/runs/{run_id}").json()
    plan = detail["plan"]
    assert any(preview["destination_path"] == "研究" for preview in plan["preview"])
    operations = plan["payload"]["operations"]
    operations[-1]["enabled"] = False
    edited = client.patch(f"/api/agent/plans/{plan['id']}", json={"version": plan["version"], "operations": operations})
    assert edited.status_code == 200, edited.text
    approved = client.post(f"/api/agent/plans/{plan['id']}/approve", json={"plan_version": edited.json()["version"]})
    assert approved.status_code == 200, approved.text
    with factory() as db:
        assert db.get(Folder, db.get(Document, doc_id).folder_id).name == "研究"
        assert db.scalar(select(func.count()).select_from(Tag)) == 0
    assert client.post(f"/api/agent/runs/{run_id}/undo").status_code == 200
    with factory() as db:
        assert db.get(Document, doc_id).folder_id is None


@pytest.mark.parametrize("change", ["document_version", "permission", "lease", "foreign_id"])
def test_planning_rechecks_versions_permissions_lease_and_model_ids(client, factory, monkeypatch, change):
    kb_id, doc_id, run_id, job_id = enqueue_plan(client, factory, monkeypatch)

    class Gateway:
        llm_configured = True

        def chat(self, *_args, **_kwargs):
            with factory() as writer:
                if change == "document_version":
                    update_document(writer, get_actor(writer), doc_id, {"display_name": "人工已修改.md"})
                elif change == "permission":
                    writer.execute(delete(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == kb_id))
                elif change == "lease":
                    writer.get(IngestionJob, job_id).lease_owner = "new-owner"
                writer.commit()
            return json.dumps({"summary": "增加标签", "folders": [], "documents": [{
                "document_id": "foreign-id" if change == "foreign_id" else doc_id,
                "folder_id": None, "new_tag_names": ["研究"], "reason": "主题"}]})

    process_organization_job(job_id, factory, configured(), owner="worker", gateway=Gateway())
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(AgentPlan)) == 0
        assert db.scalar(select(func.count()).select_from(Folder)) == 0
        assert db.scalar(select(func.count()).select_from(Tag)) == 0
        job = db.get(IngestionJob, job_id)
        assert job.status == ("running" if change == "lease" else "failed")
        if change == "lease":
            assert job.lease_owner == "new-owner"
    if change == "permission":
        assert client.get(f"/api/agent/runs/{run_id}").status_code == 403
        assert client.get("/api/review/suggestions").json()["items"] == []


def test_organization_requires_no_tools_and_blocks_oversized_scope_before_enqueue(client, factory, monkeypatch):
    import app.api.review as api

    monkeypatch.setattr(api, "get_runtime_settings", lambda *_: configured())
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    with factory() as db:
        for index in range(51):
            create_source(db, kb_id, f"资料{index}.md")
        db.commit()
    result = client.post("/api/review/plans", json={"kb_id": kb_id})
    assert result.status_code == 409 and result.json()["code"] == "organization_scope_too_large"
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(IngestionJob)) == 0


def test_classification_adds_tags_preserves_manual_tags_and_skips_noop_move(client, factory):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    manual = client.post(f"/api/knowledge-bases/{kb_id}/tags", json={"name": "人工保留"}).json()["id"]
    suggested = client.post(f"/api/knowledge-bases/{kb_id}/tags", json={"name": "新增主题"}).json()["id"]
    with factory() as db:
        doc, item = create_source(db, kb_id, payload={"existing_folder_id": None, "existing_tag_ids": [suggested],
            "new_tag_names": [], "short_summary": "", "reason": "新增主题"})
        db.add(DocumentTag(document_id=doc.id, tag_id=manual, kb_id=kb_id))
        db.commit()
        doc_id, item_id = doc.id, item.id
    response = client.post(f"/api/review/suggestions/{item_id}", json={"action": "apply", "document_version": 1})
    assert response.status_code == 200, response.text
    with factory() as db:
        assert db.get(Document, doc_id).version == 2  # Tag addition only, no no-op root move.
        assert set(db.scalars(select(DocumentTag.tag_id).where(DocumentTag.document_id == doc_id))) == {manual, suggested}
        assert db.scalar(select(func.count()).select_from(Folder)) == 0


def test_refresh_stale_pending_keeps_snapshot_and_has_recoverable_job_metadata(client, factory):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    with factory() as db:
        doc, item = create_source(db, kb_id)
        doc.index_status = doc.summary_status = doc.classification_status = "ready"
        doc.version = 2
        db.commit()
        doc_id, item_id = doc.id, item.id
    stale = client.post(f"/api/review/suggestions/{item_id}/refresh", json={"document_version": 1})
    assert stale.status_code == 409 and stale.json()["code"] == "version_conflict"
    refreshed = client.post(f"/api/review/suggestions/{item_id}/refresh", json={"document_version": 2})
    assert refreshed.status_code == 200, refreshed.text
    job_id = refreshed.json()["job_id"]
    with factory() as db:
        doc, item, job = db.get(Document, doc_id), db.get(ClassificationSuggestion, item_id), db.get(IngestionJob, job_id)
        assert item.document_version == 1 and item.status == "pending"
        assert doc.classification_status == "queued" and doc.index_status == doc.summary_status == "ready"
        assert job.payload == {"review_suggestion_id": item_id, "classification_only": True}
    page = client.get("/api/review/suggestions", params={"document_id": doc_id}).json()
    assert page["items"][0]["refresh_job_id"] == job_id and page["items"][0]["refresh_status"] == "queued"
    busy = client.post(f"/api/review/suggestions/{item_id}/refresh", json={"document_version": 2})
    assert busy.status_code == 409 and busy.json()["code"] == "document_busy"
    assert client.post(f"/api/review/suggestions/{item_id}", json={"action": "reject", "document_version": 2}).status_code == 200
    denied = client.post(f"/api/review/suggestions/{item_id}/refresh", json={"document_version": 2})
    assert denied.status_code == 409 and denied.json()["code"] == "not_pending"


def test_recovered_organization_job_preserves_existing_review_plan(client, factory, monkeypatch):
    _, doc_id, run_id, job_id = enqueue_plan(client, factory, monkeypatch)

    class Gateway:
        llm_configured = True
        calls = 0

        def chat(self, *_args, **_kwargs):
            self.calls += 1
            assert self.calls == 1
            return json.dumps({"summary": "增加主题标签", "documents": [{"document_id": doc_id,
                "folder_id": None, "new_tag_names": ["研究"], "reason": "主题一致"}]})

    gateway = Gateway()
    process_organization_job(job_id, factory, configured(), owner="worker", gateway=gateway)
    with factory() as db:
        plan = db.scalar(select(AgentPlan).where(AgentPlan.run_id == run_id))
        plan_id, payload = plan.id, dict(plan.payload)
        job = db.get(IngestionJob, job_id)
        job.status, job.lease_owner = "running", "recovered"
        db.commit()
    process_organization_job(job_id, factory, configured(), owner="recovered", gateway=gateway)
    with factory() as db:
        plan = db.get(AgentPlan, plan_id)
        assert plan.payload == payload and plan.status == "pending_review"
        assert db.get(IngestionJob, job_id).status == "completed"
    assert gateway.calls == 1


@pytest.mark.parametrize("timeout", [30, 120, 240])
def test_organization_respects_saved_timeout_and_uses_one_background_request(client, factory, monkeypatch, timeout):
    import app.agent.organization as organization

    _, doc_id, _, job_id = enqueue_plan(client, factory, monkeypatch)
    saved = configured().model_copy(update={"llm_timeout_seconds": timeout, "llm_max_retries": 2})
    calls, snapshots = [], []

    def respond(request):
        calls.append(json.loads(request.content))
        with factory() as db:
            job = db.get(IngestionJob, job_id)
            assert job.stage == "planning" and job.progress == 0
            details = job.payload["organization"]
            assert details["timeout_seconds"] == timeout and details["automatic_retries"] == 0
        assert calls[-1]["max_tokens"] == 1800
        assert doc_id not in calls[-1]["messages"][1]["content"]
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"summary": "无需改动", "documents": []})}}]})

    def create_gateway(settings, **options):
        snapshots.append((settings, options))
        return ModelGateway(settings, transport=httpx.MockTransport(respond), **options)

    monkeypatch.setattr(organization, "ModelGateway", create_gateway)
    process_organization_job(job_id, factory, saved, owner="worker")
    assert len(calls) == len(snapshots) == 1
    assert snapshots[0][0].llm_timeout_seconds == timeout and snapshots[0][0].llm_max_retries == 0
    assert snapshots[0][1] == {"workload": "background"}
    assert saved.llm_timeout_seconds == timeout and saved.llm_max_retries == 2
    with factory() as db:
        assert db.get(IngestionJob, job_id).status == "completed"
        assert db.get(Document, doc_id).folder_id is None


@pytest.mark.parametrize("failure,code,stage", [
    ("timeout", "read_timeout", "planning"),
    ("network", "connect_error", "planning"),
    ("truncated", "output_truncated", "planning"),
    ("invalid", "invalid_plan_response", "validating"),
])
def test_organization_distinguishes_retryable_failures_without_resending(client, factory, monkeypatch, failure, code, stage):
    import app.agent.organization as organization

    _, doc_id, run_id, job_id = enqueue_plan(client, factory, monkeypatch)
    calls = []

    def respond(request):
        calls.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("secret request must not be exposed")
        if failure == "network":
            raise httpx.ConnectError("secret provider endpoint must not be exposed")
        content = "{" if failure == "invalid" else '{"summary":"unfinished'
        return httpx.Response(200, json={"choices": [{"finish_reason": "length" if failure == "truncated" else "stop",
            "message": {"content": content}}]})

    def create_gateway(settings, **options):
        return ModelGateway(settings, transport=httpx.MockTransport(respond), **options)

    monkeypatch.setattr(organization, "ModelGateway", create_gateway)
    process_organization_job(job_id, factory, configured(), owner="worker")
    assert len(calls) == 1
    with factory() as db:
        job, run = db.get(IngestionJob, job_id), db.get(AgentRun, run_id)
        assert job.status == run.status == "failed" and job.stage == stage
        assert job.lease_owner is job.lease_until is None
        diagnostic = job.payload["organization"]
        assert diagnostic["error_code"] == code and diagnostic["retryable"] is True
        assert diagnostic["timeout_seconds"] == 120 and diagnostic["elapsed_ms"] >= 0
        assert "secret" not in job.error and job.error == run.error
        event = db.scalar(select(JobEvent).where(JobEvent.job_id == job_id, JobEvent.type == "error"))
        assert event.data["error_code"] == code and event.data["stage"] == stage
        assert db.get(Document, doc_id).folder_id is None
        assert db.scalar(select(func.count()).select_from(AgentPlan)) == 0


def test_compact_references_roundtrip_existing_ids_and_keep_original_snapshot():
    from app.agent.organization import (
        OrganizationDraft,
        compact_source,
        convert_draft,
        expand_references,
        model_payload,
    )

    source = {"documents": [{"id": "document-uuid", "folder_id": None, "tag_ids": [], "name": "资料", "summary": "摘要" * 400}],
        "folders": [{"id": "folder-uuid", "parent_id": None, "name": "研究"}],
        "tags": [{"id": "tag-uuid", "name": "主题", "aliases": []}]}
    original = json.dumps(source, ensure_ascii=False)
    compact, references = compact_source(source)
    text = model_payload("按主题归档", compact)
    assert "document-uuid" not in text and len(text) < len(original)
    draft = OrganizationDraft(summary="按主题归档", documents=[{"document_id": "D1", "folder_id": "F1",
        "existing_tag_ids": ["T1"], "reason": "主题一致"}])
    plan = convert_draft(expand_references(draft, references), source)
    move, tags = plan.operations
    assert move.target_ids == ["document-uuid"] and move.params.folder_id == "folder-uuid"
    assert tags.params.tag_ids == ["tag-uuid"]
    assert json.dumps(source, ensure_ascii=False) == original
    with pytest.raises(ValueError):
        expand_references(OrganizationDraft(summary="不能重复", documents=[draft.documents[0],
            {"document_id": "document-uuid", "folder_id": None, "reason": "重复"}]), references)


@pytest.mark.parametrize("ref", ["move-2", "tags-3"])
def test_model_folder_references_cannot_collide_with_generated_operation_ids(ref):
    from app.agent.organization import OrganizationDraft, convert_draft

    draft = OrganizationDraft(summary="合法新目录引用", folders=[{"ref": ref, "name": "研究", "parent_id": None}],
        documents=[{"document_id": "actual-doc", "folder_id": f"ref:{ref}", "new_tag_names": ["研究"], "reason": "主题"}])
    plan = convert_draft(draft, {"documents": [{"id": "actual-doc", "folder_id": None, "tag_ids": []}], "folders": [], "tags": []})
    ids = [operation.operation_id for operation in plan.operations]
    assert len(ids) == len(set(ids)) and ref in ids
    move = next(operation for operation in plan.operations if operation.type == "move_documents")
    assert move.params.folder_id == f"ref:{ref}" and move.dependencies == [ref]


def test_legacy_suggestion_approval_delegates_to_audited_service(client, factory):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    with factory() as db:
        doc, item = create_source(db, kb_id)
        db.commit()
        doc_id, item_id = doc.id, item.id
    response = client.post(f"/api/documents/{doc_id}/suggestion", json={"action": "apply"})
    assert response.status_code == 200, response.text
    assert response.json()["id"] == item_id and response.json()["status"] == "applied"
    run_id = response.json()["run_id"]
    assert run_id and client.post(f"/api/agent/runs/{run_id}/undo").status_code == 200


def test_batch_locks_in_stable_kb_order_but_returns_request_order(client, factory, monkeypatch):
    import app.api.review as api

    first = client.get("/api/knowledge-bases").json()[0]["id"]
    second = client.post("/api/knowledge-bases", json={"name": "第二库"}).json()["id"]
    calls = []
    with factory() as db:
        _, a = create_source(db, first)
        _, b = create_source(db, second)
        db.commit()
        items = [(a.id, first), (b.id, second)]

    def decide(_db, _actor, suggestion_id, _decision):
        calls.append(suggestion_id)
        return {"suggestion_id": suggestion_id, "status": "rejected"}

    monkeypatch.setattr(api, "decide_suggestion", decide)
    request_order = [item[0] for item in sorted(items, key=lambda item: item[1], reverse=True)]
    response = client.post("/api/review/suggestions/batch", json={"action": "reject", "items": [
        {"suggestion_id": identifier, "document_version": 1} for identifier in request_order]})
    assert response.status_code == 200
    assert calls == list(reversed(request_order))
    assert [item["suggestion_id"] for item in response.json()["items"]] == request_order
