"""Deletion proposals only touch isolated metadata after explicit review."""

import pytest
from sqlalchemy import func, select
from test_agent_workflow import make_plan, operation
from test_agent_workflow import workspace as workspace

from app.agent.executor import edit_plan, execute_plan, persist_plan, undo_run
from app.agent.organization import (
    OrganizationDraft,
    compact_source,
    convert_draft,
    expand_references,
    source_snapshot,
)
from app.agent.plans import PlanDraft, PlanEdit
from app.core.errors import AppError
from app.db.models import (
    AgentRun,
    AuditLog,
    Document,
    DocumentTag,
    Folder,
    KnowledgeBaseMember,
    Tag,
    new_id,
    utcnow,
)
from app.services import library
from app.services.review import plan_preview


def add_tag(db, kb_id, doc=None, name="旧主题"):
    tag = Tag(kb_id=kb_id, name=name, normalized_name=library.normalized_name(name), color="#123456", aliases=[f"{name}别名"])
    db.add(tag)
    db.flush()
    if doc:
        library.set_document_tags(db, doc, [tag.id], "add")
    return tag


def test_used_tag_deletion_requires_review_and_restores_metadata_and_associations(workspace):
    db, actor, kb, doc = workspace
    tag = add_tag(db, kb.id, doc)
    keep = add_tag(db, kb.id, doc, "保留标签")
    trashed = Document(kb_id=kb.id, owner_id=actor.id, display_name="回收站.md", original_filename="回收站.md",
        ext="md", mime_type="text/markdown", sha256="b" * 64, size_bytes=10, storage_key="private/trashed/original", deleted_at=utcnow())
    db.add(trashed)
    db.flush()
    library.set_document_tags(db, trashed, [tag.id])
    db.commit()
    original_tag_id, tag_version = tag.id, tag.version
    run, plan = make_plan(workspace, [operation("delete_tags", tag.id, {})])
    assert db.get(Tag, tag.id) and doc.version == 1 and trashed.version == 1
    assert plan.payload["base_tag_links"] == {tag.id: sorted([doc.id, trashed.id])}
    assert plan.payload["expected_changes"] == 3 and plan.payload["risk_level"] == "high"
    preview = plan_preview(db, plan)[0]["targets"][0]
    assert preview["kind"] == "tag" and preview["usage_count"] == 2
    assert {item["name"] for item in preview["affected_documents"]} == {doc.display_name, trashed.display_name}
    with pytest.raises(AppError, match="额外确认"):
        execute_plan(db, actor, plan.id, 1)
    result = execute_plan(db, actor, plan.id, 1, confirm_high_risk=True)
    db.commit()
    assert db.get(Tag, original_tag_id) is None
    assert list(db.scalars(select(DocumentTag.tag_id).where(DocumentTag.document_id == doc.id))) == [keep.id]
    assert doc.version == 2 and trashed.version == 2
    assert trashed.deleted_at and doc.storage_key == "private/test/original"
    assert original_tag_id in result["operations"][0]["affected_ids"]
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.run_id == run.id)) == 3
    assert execute_plan(db, actor, plan.id, 1, True) == result
    assert doc.version == 2
    undo_run(db, actor, run.id)
    db.commit()
    restored = db.get(Tag, original_tag_id)
    assert (restored.name, restored.aliases, restored.color, restored.version) == ("旧主题", ["旧主题别名"], "#123456", tag_version + 2)
    assert set(db.scalars(select(DocumentTag.tag_id).where(DocumentTag.document_id == doc.id))) == {keep.id, original_tag_id}
    assert db.scalar(select(DocumentTag.document_id).where(DocumentTag.document_id == trashed.id, DocumentTag.tag_id == original_tag_id))
    assert trashed.deleted_at and trashed.storage_key == "private/trashed/original"
    assert undo_run(db, actor, run.id) == {"status": "undone"}


@pytest.mark.parametrize("change", ["new_link", "document_edit", "tag_edit"])
def test_tag_deletion_rejects_stale_membership_or_versions(workspace, change):
    db, actor, kb, doc = workspace
    tag = add_tag(db, kb.id, doc if change != "new_link" else None)
    db.commit()
    _, plan = make_plan(workspace, [operation("delete_tags", tag.id, {})])
    if change == "new_link":
        library.update_document(db, actor, doc.id, {"tag_ids": [tag.id], "tag_mode": "add"})
    elif change == "document_edit":
        library.update_document(db, actor, doc.id, {"display_name": "人工修改.md"})
    else:
        tag.name, tag.version = "人工修改标签", tag.version + 1
    db.commit()
    with pytest.raises(AppError) as error:
        execute_plan(db, actor, plan.id, 1, True)
    assert error.value.code == "version_conflict" and db.get(Tag, tag.id)


@pytest.mark.parametrize("change", ["document_edit", "reused_name", "reused_alias"])
def test_tag_deletion_undo_does_not_overwrite_later_changes(workspace, change):
    db, actor, kb, doc = workspace
    tag = add_tag(db, kb.id, doc)
    db.commit()
    tag_id = tag.id
    run, plan = make_plan(workspace, [operation("delete_tags", tag_id, {})])
    execute_plan(db, actor, plan.id, 1, True)
    db.commit()
    if change == "document_edit":
        library.update_document(db, actor, doc.id, {"display_name": "新标题.md"})
    elif change == "reused_name":
        add_tag(db, kb.id, name="旧主题")
    else:
        other = add_tag(db, kb.id, name="其他标签")
        other.aliases = ["旧主题"]
    db.commit()
    with pytest.raises(AppError) as error:
        undo_run(db, actor, run.id)
    assert error.value.code == "undo_conflict"
    db.rollback()
    assert db.get(Tag, tag_id) is None
    assert not list(db.scalars(select(DocumentTag.tag_id).where(DocumentTag.document_id == doc.id)))
    if change == "document_edit":
        assert db.get(Document, doc.id).display_name == "新标题.md"


def test_empty_folder_soft_deletion_has_final_empty_check_and_safe_undo(workspace):
    db, actor, kb, doc = workspace
    folder = library.create_folder(db, actor, kb.id, {"name": "空目录"})
    db.commit()
    run, plan = make_plan(workspace, [operation("trash_empty_folders", folder.id, {})])
    execute_plan(db, actor, plan.id, 1, True)
    db.commit()
    assert folder.deleted_at and doc.storage_key == "private/test/original"
    undo_run(db, actor, run.id)
    db.commit()
    assert folder.deleted_at is None and folder.name == "空目录"
    _, second = make_plan(workspace, [operation("trash_empty_folders", folder.id, {})])
    library.update_document(db, actor, doc.id, {"folder_id": folder.id})
    db.commit()
    with pytest.raises(AppError) as error:
        execute_plan(db, actor, second.id, 1, True)
    assert error.value.code == "folder_not_empty" and folder.deleted_at is None


def test_empty_folder_checks_children_and_rejects_new_same_name_on_undo(workspace):
    db, actor, kb, _ = workspace
    parent = library.create_folder(db, actor, kb.id, {"name": "父目录"})
    child = library.create_folder(db, actor, kb.id, {"name": "子目录", "parent_id": parent.id})
    db.commit()
    with pytest.raises(AppError) as error:
        make_plan(workspace, [operation("trash_empty_folders", parent.id, {})])
    assert error.value.code == "folder_not_empty"
    db.rollback()
    run, plan = make_plan(workspace, [operation("trash_empty_folders", child.id, {})])
    execute_plan(db, actor, plan.id, 1, True)
    db.commit()
    library.create_folder(db, actor, kb.id, {"name": "子目录", "parent_id": parent.id})
    db.commit()
    with pytest.raises(AppError) as error:
        undo_run(db, actor, run.id)
    assert error.value.code == "duplicate_folder"
    db.rollback()
    assert db.get(Folder, child.id).deleted_at


def test_deletion_review_cannot_expand_targets_or_ignore_revoked_permissions(workspace):
    db, actor, kb, doc = workspace
    first, other = add_tag(db, kb.id, doc), add_tag(db, kb.id, name="其他")
    db.commit()
    run, plan = make_plan(workspace, [operation("delete_tags", first.id, {})])
    edited = {**plan.payload["operations"][0], "target_ids": [other.id]}
    with pytest.raises(AppError) as error:
        edit_plan(db, actor, plan.id, PlanEdit(version=1, operations=[edited]))
    assert error.value.code == "invalid_plan_edit"
    member = db.scalar(select(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == kb.id))
    member.role = "viewer"
    db.commit()
    with pytest.raises(AppError) as error:
        execute_plan(db, actor, plan.id, 1, True)
    assert error.value.code == "forbidden" and db.get(Tag, first.id)
    assert run.status == "pending_review"


def test_organization_proposes_deletion_with_real_counts_and_rejects_nonempty_or_foreign_targets(workspace):
    db, actor, kb, doc = workspace
    folder = library.create_folder(db, actor, kb.id, {"name": "空目录"})
    tag = add_tag(db, kb.id, doc)
    db.commit()
    source, observed = source_snapshot(db, actor, kb.id)
    assert source["tags"][0]["usage_count"] == 1
    assert source["folders"][0]["document_count"] == source["folders"][0]["child_count"] == 0
    compact, references = compact_source(source)
    proposal = OrganizationDraft(summary="清理空目录与废弃标签", empty_folder_ids=[compact["folders"][0]["id"]],
                                 delete_tag_ids=[compact["tags"][0]["id"]])
    draft = convert_draft(expand_references(proposal, references), source)
    assert [op.type for op in draft.operations] == ["trash_empty_folders", "delete_tags"]
    run = AgentRun(kb_id=kb.id, actor_id=actor.id, thread_id=new_id(), goal="清理废弃目录和标签")
    db.add(run)
    db.flush()
    plan = persist_plan(db, actor, run, draft, observed)
    assert plan.status == "pending_review" and folder.deleted_at is None and db.get(Tag, tag.id)
    source["folders"][0]["child_count"] = 1
    with pytest.raises(AppError, match="空的文件夹"):
        convert_draft(expand_references(proposal, references), source)
    with pytest.raises(AppError) as error:
        convert_draft(OrganizationDraft(summary="越权", delete_tag_ids=["foreign-tag"]), source)
    assert error.value.code == "invalid_plan_resource"


def test_plan_rejects_using_deleted_destinations_and_tags(workspace):
    db, actor, kb, doc = workspace
    folder = library.create_folder(db, actor, kb.id, {"name": "空目录"})
    tag = add_tag(db, kb.id)
    db.commit()
    for operations in (
        [operation("move_documents", doc.id, {"folder_id": folder.id}, "move"), operation("trash_empty_folders", folder.id, {}, "delete")],
        [operation("update_document_tags", doc.id, {"tag_ids": [tag.id]}, "tag"), operation("delete_tags", tag.id, {}, "delete")],
    ):
        with pytest.raises(AppError) as error:
            make_plan(workspace, operations)
        assert error.value.code == "conflicting_operations"
        db.rollback()


def test_deletion_snapshots_cannot_be_injected_by_plan_draft(workspace):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        PlanDraft(summary="伪造影响", operations=[operation("delete_tags", "tag", {})], base_tag_links={"tag": []})


def test_tag_usage_drift_during_planning_requires_fresh_review(workspace):
    db, actor, kb, doc = workspace
    tag = add_tag(db, kb.id, doc)
    db.commit()
    run = AgentRun(kb_id=kb.id, actor_id=actor.id, thread_id=new_id(), goal="删除废弃标签")
    db.add(run)
    db.flush()
    draft = PlanDraft(summary="删除前先审阅", operations=[operation("delete_tags", tag.id, {})])
    with pytest.raises(AppError) as error:
        persist_plan(db, actor, run, draft, observed_tag_usage={tag.id: 0})
    assert error.value.code == "version_conflict" and db.get(Tag, tag.id)
