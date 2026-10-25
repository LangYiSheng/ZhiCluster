"""All resources here are disposable SQLite fixtures, never daily documents."""

import json

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from test_agent_workflow import operation
from test_agent_workflow import workspace as workspace
from test_review_api import configured, create_source

from app.agent.executor import edit_plan, execute_plan, persist_plan, undo_run
from app.agent.organization import OrganizationDraft, convert_draft, process_organization_job, source_snapshot
from app.agent.organization_policy import append_cleanup, policy_from_source
from app.agent.plans import PlanDraft, PlanEdit
from app.core.errors import AppError
from app.db.models import (
    AgentPlan,
    AgentRun,
    Document,
    DocumentTag,
    Folder,
    IngestionJob,
    Tag,
    new_id,
    utcnow,
)
from app.services import library


def another_document(db, actor, kb, name="另一份.md", folder_id=None, deleted=False):
    doc = Document(kb_id=kb.id, owner_id=actor.id, folder_id=folder_id, display_name=name, original_filename=name,
        mime_type="text/markdown", ext="md", sha256="b" * 64, size_bytes=10, storage_key=f"isolated/{new_id()}/original",
        parse_status="ready", deleted_at=utcnow() if deleted else None)
    db.add(doc)
    db.flush()
    return doc


def mode_plan(workspace, mode, operations, *, ids=None, cleanup=True):
    db, actor, kb, doc = workspace
    source, observed = source_snapshot(db, actor, kb.id, ids or [doc.id])
    policy = policy_from_source(mode, source, cleanup)
    draft = append_cleanup(PlanDraft(summary="仅整理已选资料", operations=operations), source, policy)
    run = AgentRun(kb_id=kb.id, actor_id=actor.id, thread_id=new_id(), goal="整理选定主题")
    db.add(run)
    db.flush()
    plan = persist_plan(db, actor, run, draft, observed, organization=policy)
    db.commit()
    return run, plan


@pytest.mark.parametrize(("mode", "kind", "params"), [
    ("tags", "move_documents", {"folder_id": None}),
    ("folders", "update_document_tags", {"new_tag_names": ["不能改"]}),
    ("both", "rename_document", {"name": "不能改.md"}),
    ("both", "trash_documents", {}),
])
def test_server_rejects_operations_outside_selected_mode_even_when_disabled(workspace, mode, kind, params):
    _, _, _, doc = workspace
    for enabled in (True, False):
        with pytest.raises(AppError) as error:
            mode_plan(workspace, mode, [{**operation(kind, doc.id, params), "enabled": enabled}])
        assert error.value.code == "organization_mode_violation"
        workspace[0].rollback()


def test_model_mode_validation_ignores_no_missing_folder_as_root_move(workspace):
    db, actor, kb, doc = workspace
    original = library.create_folder(db, actor, kb.id, {"name": "人工位置"})
    library.update_document(db, actor, doc.id, {"folder_id": original.id})
    source, _ = source_snapshot(db, actor, kb.id)
    draft = convert_draft(OrganizationDraft(summary="标签", documents=[{
        "document_id": doc.id, "new_tag_names": ["主题"], "reason": "事实主题",
    }]), source, "tags")
    assert [op.type for op in draft.operations] == ["update_document_tags"]
    with pytest.raises(AppError) as error:
        convert_draft(OrganizationDraft(summary="越界", documents=[{
            "document_id": doc.id, "folder_id": None, "reason": "移出",
        }]), source, "tags")
    assert error.value.code == "organization_mode_violation"


def test_merge_cleans_only_moved_source_tree_and_undo_restores_parents_before_documents(workspace):
    db, actor, kb, first = workspace
    parent = library.create_folder(db, actor, kb.id, {"name": "原始资料"})
    left = library.create_folder(db, actor, kb.id, {"name": "旧位置甲", "parent_id": parent.id})
    right = library.create_folder(db, actor, kb.id, {"name": "旧位置乙", "parent_id": parent.id})
    unrelated = library.create_folder(db, actor, kb.id, {"name": "用户另建空目录"})
    another_document(db, actor, kb, name="本次未选择.md")
    library.update_document(db, actor, first.id, {"folder_id": left.id})
    second = another_document(db, actor, kb, folder_id=right.id)
    db.commit()
    operations = [operation("create_folder", params={"name": "同一主题"}, operation_id="new")]
    operations += [operation("move_documents", doc.id, {"folder_id": "ref:new"}, f"move-{i}", ["new"])
                   for i, doc in enumerate((first, second))]
    run, plan = mode_plan(workspace, "folders", operations, ids=[first.id, second.id])
    cleanup = plan.payload["operations"][-1]
    assert cleanup["type"] == "trash_empty_folders" and cleanup["target_ids"][-1] == parent.id
    assert set(cleanup["target_ids"]) == {parent.id, left.id, right.id}
    assert set(cleanup["dependencies"]) == {"move-0", "move-1"}
    with pytest.raises(AppError) as error:
        execute_plan(db, actor, plan.id, 1)
    assert error.value.code == "high_risk_confirmation_required"
    result = execute_plan(db, actor, plan.id, 1, True)
    db.commit()
    assert result["undo_available"] and first.folder_id == second.folder_id
    destination = db.get(Folder, first.folder_id)
    assert destination.name == "同一主题"
    assert all(folder.deleted_at for folder in (parent, left, right))
    assert unrelated.deleted_at is None and first.storage_key == "private/test/original"
    undo_run(db, actor, run.id)
    db.commit()
    assert all(folder.deleted_at is None for folder in (parent, left, right))
    assert first.folder_id == left.id and second.folder_id == right.id and destination.deleted_at


@pytest.mark.parametrize("obstacle", ["unselected", "new_document", "new_child", "recycled_descendant"])
def test_cleanup_never_deletes_nonempty_or_outside_scope_directories(workspace, obstacle):
    db, actor, kb, doc = workspace
    source = library.create_folder(db, actor, kb.id, {"name": "原文件夹"})
    destination = library.create_folder(db, actor, kb.id, {"name": "目的地"})
    library.update_document(db, actor, doc.id, {"folder_id": source.id})
    if obstacle == "unselected":
        another_document(db, actor, kb, folder_id=source.id)
    db.commit()
    _, plan = mode_plan(workspace, "folders", [operation("move_documents", doc.id, {"folder_id": destination.id})])
    if obstacle == "unselected":
        assert not any(op["type"] == "trash_empty_folders" for op in plan.payload["operations"])
        execute_plan(db, actor, plan.id, 1)
        db.commit()
        assert source.deleted_at is None
        return
    assert plan.payload["operations"][-1]["type"] == "trash_empty_folders"
    if obstacle == "new_document":
        another_document(db, actor, kb, folder_id=source.id)
    elif obstacle == "new_child":
        library.create_folder(db, actor, kb.id, {"name": "后来子目录", "parent_id": source.id})
    else:
        child = library.create_folder(db, actor, kb.id, {"name": "回收站子目录", "parent_id": source.id})
        another_document(db, actor, kb, folder_id=child.id, deleted=True)
        child.deleted_at = utcnow()
    db.commit()
    with pytest.raises(AppError) as error:
        execute_plan(db, actor, plan.id, 1, True)
    assert error.value.code == "folder_not_empty"
    assert source.deleted_at is None and doc.folder_id == source.id


def test_cleanup_option_can_be_removed_without_changing_scope_or_enabling_new_operations(workspace):
    db, actor, kb, doc = workspace
    source = library.create_folder(db, actor, kb.id, {"name": "保留原空目录"})
    library.update_document(db, actor, doc.id, {"folder_id": source.id})
    other = another_document(db, actor, kb)
    db.commit()
    _, plan = mode_plan(workspace, "folders", [operation("move_documents", doc.id, {"folder_id": None})])
    original_policy = plan.payload["organization"]
    operations = plan.payload["operations"]
    operations[-1] = {**operations[-1], "enabled": False}
    edited = edit_plan(db, actor, plan.id, PlanEdit(version=1, operations=operations))
    db.commit()
    assert edited.payload["organization"] == original_policy and edited.payload["risk_level"] == "low"
    expanded = [{**operations[0], "target_ids": [doc.id, other.id]}, *operations[1:]]
    with pytest.raises(AppError) as error:
        edit_plan(db, actor, plan.id, PlanEdit(version=2, operations=expanded))
    assert error.value.code == "organization_scope_violation"
    db.rollback()
    execute_plan(db, actor, plan.id, 2)
    db.commit()
    assert doc.folder_id is None and source.deleted_at is None


def test_plan_drafts_and_edits_cannot_supply_server_owned_policy():
    op = operation("move_documents", "doc", {"folder_id": None})
    with pytest.raises(ValidationError):
        PlanDraft(summary="越权", operations=[op], organization={"mode": "both", "document_ids": ["doc"]})
    with pytest.raises(ValidationError):
        PlanEdit(version=1, operations=[op], organization=None)


def test_full_library_scope_also_proposes_preexisting_empty_tree_without_any_moves(workspace):
    db, actor, kb, doc = workspace
    parent = library.create_folder(db, actor, kb.id, {"name": "之前就空的父目录"})
    child = library.create_folder(db, actor, kb.id, {"name": "之前就空的子目录", "parent_id": parent.id})
    db.commit()
    source, observed = source_snapshot(db, actor, kb.id, [doc.id])
    assert source["complete_scope"]
    policy = policy_from_source("folders", source)
    draft = append_cleanup(None, source, policy)
    assert [op.type for op in draft.operations] == ["trash_empty_folders"]
    assert draft.operations[0].target_ids == [child.id, parent.id]
    assert policy.cleanup_scope == "knowledge_base"
    run = AgentRun(kb_id=kb.id, actor_id=actor.id, thread_id=new_id(), goal="清空以前的空文件夹")
    db.add(run)
    db.flush()
    plan = persist_plan(db, actor, run, draft, observed, organization=policy)
    db.commit()
    assert parent.deleted_at is child.deleted_at is None and doc.folder_id is None
    execute_plan(db, actor, plan.id, 1, True)
    db.commit()
    assert parent.deleted_at and child.deleted_at and doc.folder_id is None
    undo_run(db, actor, run.id)
    db.commit()
    assert parent.deleted_at is child.deleted_at is None


def test_existing_empty_parent_used_by_new_topic_is_not_offered_for_cleanup(workspace):
    db, actor, kb, doc = workspace
    parent = library.create_folder(db, actor, kb.id, {"name": "复用分组"})
    db.commit()
    operations = [operation("create_folder", params={"name": "相同主题", "parent_id": parent.id}, operation_id="topic"),
        operation("move_documents", doc.id, {"folder_id": "ref:topic"}, "move", ["topic"])]
    _, plan = mode_plan(workspace, "folders", operations)
    assert not any(op["type"] == "trash_empty_folders" for op in plan.payload["operations"])
    execute_plan(db, actor, plan.id, 1)
    db.commit()
    assert parent.deleted_at is None and db.get(Folder, doc.folder_id).parent_id == parent.id


def test_legacy_folder_suggestion_applies_only_tags_and_preserves_nonroot_location(client, factory):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    folder = client.post(f"/api/knowledge-bases/{kb_id}/folders", json={"name": "人工原位置"}).json()
    with factory() as db:
        doc, suggestion = create_source(db, kb_id, payload={"existing_folder_id": "foreign-or-old", "proposed_folder_path": "不能创建",
            "existing_tag_ids": [], "new_tag_names": ["主题"], "reason": "旧建议仍可审标签"})
        doc.folder_id = folder["id"]
        db.commit()
        doc_id, suggestion_id = doc.id, suggestion.id
    result = client.post(f"/api/review/suggestions/{suggestion_id}", json={"action": "apply", "document_version": 1})
    assert result.status_code == 200, result.text
    with factory() as db:
        assert db.get(Document, doc_id).folder_id == folder["id"]
        assert list(db.scalars(select(Tag.name).join(DocumentTag, DocumentTag.tag_id == Tag.id).where(DocumentTag.document_id == doc_id))) == ["主题"]
        plan = db.scalar(select(AgentPlan).where(AgentPlan.run_id == result.json()["run_id"]))
        assert [op["type"] for op in plan.payload["operations"]] == ["update_document_tags"]
    assert client.post(f"/api/agent/runs/{result.json()['run_id']}/undo").status_code == 200
    with factory() as db:
        assert db.get(Document, doc_id).folder_id == folder["id"]


@pytest.mark.parametrize("mode", ["tags", "folders", "both"])
def test_review_api_persists_mode_and_worker_keeps_it_through_approval(client, factory, monkeypatch, mode):
    import app.api.review as api

    monkeypatch.setattr(api, "get_runtime_settings", lambda *_: configured())
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    with factory() as db:
        doc, _ = create_source(db, kb_id)
        db.commit()
        doc_id = doc.id
    response = client.post("/api/review/plans", json={"kb_id": kb_id, "mode": mode, "document_ids": [doc_id]})
    assert response.status_code == 201, response.text
    with factory() as db:
        job = db.scalar(select(IngestionJob).where(IngestionJob.kind == "organize"))
        assert job.payload["mode"] == mode
        job.status, job.lease_owner = "running", "worker"
        db.commit()
        job_id = job.id

    class Gateway:
        llm_configured = True

        def chat(self, messages, **_):
            if mode == "tags":
                return json.dumps({"summary": "只补标签", "documents": [{"document_id": "D1", "new_tag_names": ["主题"], "reason": "事实"}]})
            return json.dumps({"summary": "按主题归并", "folders": [{"ref": "topic", "name": "同类资料"}],
                "documents": [{"document_id": "D1", "folder_id": "ref:topic", "reason": "相似内容"}]})

    process_organization_job(job_id, factory, configured(), "worker", Gateway())
    detail = client.get(f"/api/agent/runs/{response.json()['id']}").json()
    plan = detail["plan"]
    assert plan and plan["payload"]["organization"]["mode"] == mode, detail
    assert client.post(f"/api/agent/plans/{plan['id']}/approve", json={"plan_version": 1}).status_code == 200
    with factory() as db:
        document = db.get(Document, doc_id)
        assert (document.folder_id is None) == (mode == "tags")
