"""Deterministic fake-model tests. These do not establish live AI capability."""

from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from pydantic import PrivateAttr, ValidationError
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.agent.executor import (
    edit_plan,
    execute_plan,
    persist_plan,
    reject_plan,
    undo_run,
)
from app.agent.graph import build_graph
from app.agent.planner import plan_with_model
from app.agent.plans import AgentPlanData, PlanDraft, PlanEdit
from app.core.errors import AppError
from app.db.models import (
    AgentPlanOperation,
    AgentRun,
    AuditLog,
    Base,
    Document,
    DocumentTag,
    Folder,
    KnowledgeBase,
    KnowledgeBaseMember,
    Tag,
    UndoRecord,
    User,
    new_id,
)
from app.services.library import create_folder, update_document


@pytest.fixture
def workspace():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        user = User(email="agent-test@example.test", display_name="测试用户")
        db.add(user)
        db.flush()
        kb = KnowledgeBase(owner_id=user.id, name="研究")
        db.add(kb)
        db.flush()
        db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=user.id, role="owner"))
        document = Document(kb_id=kb.id, owner_id=user.id, display_name="论文.md", original_filename="论文.md",
            mime_type="text/markdown", ext="md", sha256="a" * 64, size_bytes=10, storage_key="private/test/original",
            parse_status="completed", index_status="unconfigured")
        db.add(document)
        db.commit()
        yield db, user, kb, document
    engine.dispose()


def operation(kind="rename_document", target=None, params=None, operation_id="op-1", dependencies=None):
    return {"operation_id": operation_id, "type": kind, "target_ids": [target] if target else [],
            "params": params if params is not None else {"name": "整理后的论文.md"}, "description": "整理文档",
            "dependencies": dependencies or [], "enabled": True}


def make_plan(workspace, operations):
    db, actor, kb, _ = workspace
    run = AgentRun(kb_id=kb.id, actor_id=actor.id, thread_id=new_id(), goal="整理未分类文档")
    db.add(run)
    db.flush()
    plan = persist_plan(db, actor, run, PlanDraft(summary="整理研究资料", operations=operations))
    db.commit()
    return run, plan


def test_structured_plan_rejects_unknown_tools_dependencies_and_duplicate_ids():
    with pytest.raises(ValidationError):
        PlanDraft(summary="危险工具", operations=[operation("shell", "target")])
    with pytest.raises(ValidationError):
        PlanDraft(summary="无效依赖", operations=[operation(target="doc", dependencies=["later"])])
    with pytest.raises(ValidationError):
        PlanDraft(summary="重复标识", operations=[operation(target="doc"), operation(target="doc")])
    with pytest.raises(ValidationError):
        PlanDraft(summary="虚构参数", operations=[{**operation(target="doc"), "params": {"name": "x", "sql": "DROP"}}])


def test_plan_impact_and_temporary_folder_dependency():
    create = operation("create_folder", params={"name": "RAG"}, operation_id="new-folder")
    move = operation("move_documents", "doc", {"folder_id": "ref:new-folder"}, "move", ["new-folder"])
    data = AgentPlanData(kb_id="kb", goal="整理", summary="移动", operations=[create, move])
    assert data.expected_changes == 2 and data.risk_level == "low"
    move["dependencies"] = []
    with pytest.raises(ValidationError):
        PlanDraft(summary="非法临时引用", operations=[create, move])


def test_approval_executes_edited_plan_once_and_undo_restores(workspace):
    db, actor, kb, doc = workspace
    original_index = doc.index_status
    first = create_folder(db, actor, kb.id, {"name": "机器学习"})
    second = create_folder(db, actor, kb.id, {"name": "RAG"})
    db.commit()
    run, plan = make_plan(workspace, [operation("move_documents", doc.id, {"folder_id": first.id})])
    edited = [{**plan.payload["operations"][0], "params": {"folder_id": second.id}}]
    edit_plan(db, actor, plan.id, PlanEdit(version=1, operations=edited))
    db.commit()
    assert doc.folder_id is None  # Review, including editing, has zero business side effects.
    result = execute_plan(db, actor, plan.id, plan_version=2)
    db.commit()
    assert doc.folder_id == second.id
    assert doc.index_status == original_index
    approved_version = doc.version
    assert execute_plan(db, actor, plan.id, plan_version=2) == result
    db.commit()
    assert doc.version == approved_version
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.run_id == run.id)) >= 1
    assert db.scalar(select(func.count()).select_from(UndoRecord).where(UndoRecord.run_id == run.id)) == 1
    undo_run(db, actor, run.id)
    db.commit()
    assert doc.folder_id is None
    assert run.status == "undone"
    assert undo_run(db, actor, run.id)["status"] == "undone"


def test_high_risk_delete_requires_explicit_confirmation_and_is_recoverable(workspace):
    db, actor, _, doc = workspace
    run, plan = make_plan(workspace, [operation("trash_documents", doc.id, {})])
    with pytest.raises(AppError) as exc:
        execute_plan(db, actor, plan.id, 1)
    assert exc.value.code == "high_risk_confirmation_required"
    assert doc.deleted_at is None
    execute_plan(db, actor, plan.id, 1, confirm_high_risk=True)
    db.commit()
    assert doc.deleted_at is not None
    assert doc.storage_key == "private/test/original"
    undo_run(db, actor, run.id)
    db.commit()
    assert doc.deleted_at is None


def test_rejected_plan_does_not_mutate_business_entities(workspace):
    db, actor, _, doc = workspace
    _, plan = make_plan(workspace, [operation(target=doc.id)])
    before = (doc.display_name, doc.version)
    reject_plan(db, actor, plan.id)
    db.commit()
    assert (doc.display_name, doc.version) == before
    assert db.scalar(select(func.count()).select_from(UndoRecord)) == 0
    assert db.scalar(select(func.count()).select_from(AuditLog)) == 0
    with pytest.raises(AppError) as exc:
        execute_plan(db, actor, plan.id, 1)
    assert exc.value.code == "invalid_plan_state"


def test_stale_approval_and_stale_edit_are_rejected(workspace):
    db, actor, _, doc = workspace
    _, plan = make_plan(workspace, [operation(target=doc.id)])
    update_document(db, actor, doc.id, {"display_name": "人工修改.md"})
    db.commit()
    with pytest.raises(AppError) as exc:
        execute_plan(db, actor, plan.id, 1)
    assert exc.value.code == "version_conflict"
    with pytest.raises(AppError) as exc:
        edit_plan(db, actor, plan.id, PlanEdit(version=1, operations=plan.payload["operations"]))
    assert exc.value.code == "version_conflict"
    assert doc.display_name == "人工修改.md"


def test_undo_refuses_to_overwrite_later_manual_change(workspace):
    db, actor, _, doc = workspace
    run, plan = make_plan(workspace, [operation(target=doc.id)])
    execute_plan(db, actor, plan.id, 1)
    db.commit()
    update_document(db, actor, doc.id, {"display_name": "后续成果.md"})
    db.commit()
    with pytest.raises(AppError) as exc:
        undo_run(db, actor, run.id)
    assert exc.value.code == "undo_conflict"
    assert doc.display_name == "后续成果.md"


def test_cross_library_document_folder_and_tag_are_rejected(workspace):
    db, actor, kb, doc = workspace
    other = KnowledgeBase(owner_id=actor.id, name="另一知识库")
    db.add(other)
    db.flush()
    db.add(KnowledgeBaseMember(kb_id=other.id, user_id=actor.id, role="owner"))
    foreign_folder = Folder(kb_id=other.id, name="外库目录")
    foreign_tag = Tag(kb_id=other.id, name="外库标签", normalized_name="外库标签")
    db.add_all([foreign_folder, foreign_tag])
    db.flush()
    db.commit()
    for op in [operation("move_documents", doc.id, {"folder_id": foreign_folder.id}),
               operation("update_document_tags", doc.id, {"tag_ids": [foreign_tag.id]}),
               operation("rename_folder", foreign_folder.id, {"name": "跨库改名"})]:
        with pytest.raises(AppError) as exc:
            make_plan(workspace, [op])
        assert exc.value.code == "invalid_plan_resource"
        db.rollback()
    assert doc.kb_id == kb.id


def test_create_folder_tag_move_plan_and_undo_without_reembedding(workspace):
    db, actor, _, doc = workspace
    operations = [operation("create_folder", params={"name": "RAG"}, operation_id="folder"),
        operation("move_documents", doc.id, {"folder_id": "ref:folder"}, "move", ["folder"]),
        operation("update_document_tags", doc.id, {"new_tag_names": ["LLM", "ｌｌｍ"]}, "tags")]
    run, plan = make_plan(workspace, operations)
    execute_plan(db, actor, plan.id, 1)
    db.commit()
    folder_id = doc.folder_id
    assert folder_id and db.get(Folder, folder_id).name == "RAG"
    assert db.scalar(select(func.count()).select_from(Tag)) == 1
    assert db.scalar(select(func.count()).select_from(DocumentTag)) == 1
    assert doc.index_status == "unconfigured"
    assert db.scalar(select(func.count()).select_from(AgentPlanOperation).where(AgentPlanOperation.status == "completed")) == 3
    undo_run(db, actor, run.id)
    db.commit()
    assert doc.folder_id is None
    assert db.get(Folder, folder_id).deleted_at
    assert db.scalar(select(func.count()).select_from(Tag)) == 0


def test_checkpoint_pause_edit_resume_and_reconstruction():
    saver = InMemorySaver()  # Explicit test-only backend, never a runtime fallback.
    calls = []
    current_plan = {"destination": "before-review"}
    def plan_callback(run_id):
        calls.append(("plan", run_id))
        return "plan-1"
    def execute_callback(plan_id, decision):
        calls.append(("execute", current_plan["destination"], decision["plan_version"]))
        return {"applied": current_plan["destination"]}
    config = {"configurable": {"thread_id": "durable-test"}}
    graph = build_graph(saver, plan_callback, execute_callback, lambda _: None, lambda _: None)
    result = graph.invoke({"run_id": "run-1"}, config)
    assert result["__interrupt__"]
    assert calls == [("plan", "run-1")]
    current_plan["destination"] = "edited-by-user"
    # Rebuild the graph to emulate a process restart with an existing durable saver.
    graph = build_graph(saver, plan_callback, execute_callback, lambda _: None, lambda _: None)
    result = graph.invoke(Command(resume={"action": "approve", "plan_version": 2}), config)
    assert result["result"] == {"applied": "edited-by-user"}
    assert calls[-1] == ("execute", "edited-by-user", 2)


class ScriptedToolModel(BaseChatModel):
    responses: list[AIMessage]
    _index: int = PrivateAttr(default=0)

    @property
    def _llm_type(self) -> str:
        return "deterministic-test-tool-model"

    def bind_tools(self, tools: Any, **kwargs: Any):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        response = self.responses[self._index]
        self._index += 1
        return ChatResult(generations=[ChatGeneration(message=response)])


def test_create_agent_uses_actual_read_tool_and_validated_plan(workspace):
    db, actor, kb, doc = workspace
    expected = PlanDraft(summary="调整名称", operations=[operation(target=doc.id)])
    model = ScriptedToolModel(responses=[
        AIMessage(content="", tool_calls=[{"name": "list_documents", "args": {}, "id": "read-1"}]),
        AIMessage(content="", tool_calls=[{"name": "PlanDraft", "args": expected.model_dump(), "id": "plan-1"}]),
    ])
    observed = {}
    result = plan_with_model(db, actor, kb.id, "整理", lambda *_: None, observed, model=model)
    assert result.operations[0].target_ids == [doc.id]
    assert observed[f"document:{doc.id}"] == doc.version
    assert doc.display_name == "论文.md"


def test_model_without_actual_reads_cannot_submit_plan(workspace):
    db, actor, kb, doc = workspace
    expected = PlanDraft(summary="未经读取", operations=[operation(target=doc.id)])
    model = ScriptedToolModel(responses=[AIMessage(content="", tool_calls=[
        {"name": "PlanDraft", "args": expected.model_dump(), "id": "plan-1"}])])
    with pytest.raises(AppError) as exc:
        plan_with_model(db, actor, kb.id, "整理", lambda *_: None, {}, model=model)
    assert exc.value.code == "unverified_plan"
