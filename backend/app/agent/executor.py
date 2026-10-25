"""Permission-checked, versioned metadata transactions and conflict-safe undo."""

from sqlalchemy import delete, func, select

from app.agent.metadata_deletion import (
    capture_tag_links,
    check_deleted_tag_restore,
    check_tag_links,
    require_empty_folder,
    restore_deleted_tag,
    restore_folder,
    validate_deletions,
)
from app.agent.organization_policy import validate_policy
from app.agent.plans import AgentPlanData, PlanDraft, PlanEdit
from app.core.errors import AppError
from app.db.models import (
    AgentEvent,
    AgentPlan,
    AgentPlanOperation,
    AgentRun,
    AuditLog,
    Document,
    DocumentTag,
    Folder,
    Tag,
    UndoRecord,
    utcnow,
)
from app.services import library
from app.services.permissions import assert_can_edit_kb

ENTITY_TYPES = {"document": Document, "folder": Folder, "tag": Tag}


def emit_event(db, run_id, event_type, data):
    sequence = (db.scalar(select(func.max(AgentEvent.sequence)).where(AgentEvent.run_id == run_id)) or 0) + 1
    db.add(AgentEvent(run_id=run_id, sequence=sequence, type=event_type, data=data))
    db.flush()


def get_run(db, actor, run_id, lock=False):
    query = select(AgentRun).where(AgentRun.id == run_id).execution_options(populate_existing=True)
    run = db.scalar(query.with_for_update() if lock else query)
    if not run:
        raise AppError("not_found", "整理任务不存在", 404)
    assert_can_edit_kb(db, actor, run.kb_id)
    if run.actor_id != actor.id:
        raise AppError("forbidden", "不能访问其他用户的整理任务", 403)
    return run


def get_plan(db, actor, plan_id, lock=False):
    query = select(AgentPlan).where(AgentPlan.id == plan_id).execution_options(populate_existing=True)
    plan = db.scalar(query.with_for_update() if lock else query)
    if not plan:
        raise AppError("not_found", "整理计划不存在", 404)
    run = get_run(db, actor, plan.run_id)
    if run.kb_id != plan.kb_id:
        raise AppError("invalid_plan_resource", "整理计划与任务不属于同一知识库", 409)
    return plan


def lock_plan_namespace(db, actor, plan_id):
    """Locate without locks, then serialize writes as KB -> run -> plan."""
    located = get_plan(db, actor, plan_id)
    library.lock_kb_namespace(db, actor, located.kb_id)
    run = get_run(db, actor, located.run_id, lock=True)
    plan = get_plan(db, actor, plan_id, lock=True)
    return plan, run


def entity(db, key, kb_id, lock=False, include_deleted=False):
    kind, _, entity_id = key.partition(":")
    model = ENTITY_TYPES.get(kind)
    if model is None:
        raise AppError("invalid_plan", "计划包含非法资源类型")
    query = select(model).where(model.id == entity_id).execution_options(populate_existing=True)
    value = db.scalar(query.with_for_update() if lock else query)
    if not value or value.kb_id != kb_id or (getattr(value, "deleted_at", None) and not include_deleted):
        raise AppError("invalid_plan_resource", "计划引用的资源不存在、已删除或属于其他知识库", 409,
                       {"resource": key})
    if kind == "document" and value.folder_id and not include_deleted:
        library.validate_folder(db, kb_id, value.folder_id)
    return value


def references(draft: PlanDraft):
    keys = set()
    for operation in draft.operations:
        if not operation.enabled:
            continue
        kind = ("folder" if operation.type in {"rename_folder", "trash_empty_folders"}
                else "tag" if operation.type == "delete_tags" else "document")
        keys.update(f"{kind}:{target}" for target in operation.target_ids)
        folder_id = getattr(operation.params, "folder_id", None)
        if operation.type == "create_folder":
            folder_id = operation.params.parent_id
        if folder_id and not folder_id.startswith("ref:"):
            keys.add(f"folder:{folder_id}")
        if operation.type == "update_document_tags":
            keys.update(f"tag:{tag_id}" for tag_id in operation.params.tag_ids)
    return sorted(keys)


def capture_versions(db, kb_id, draft, observed=None, tag_links=None):
    observed = observed or {}
    versions = {}
    for key in references(draft):
        resource = entity(db, key, kb_id)
        if key in observed and resource.version != observed[key]:
            raise AppError("version_conflict", "规划期间资料发生了变化，请重新生成计划", 409,
                           {"resource": key})
        versions[key] = resource.version
    for identifier in sorted({doc for ids in (tag_links or {}).values() for doc in ids}):
        key = f"document:{identifier}"
        resource = entity(db, key, kb_id, include_deleted=True)
        if key in observed and resource.version != observed[key]:
            raise AppError("version_conflict", "规划期间标签关联的资料发生了变化，请重新生成计划", 409,
                           {"resource": key})
        versions[key] = resource.version
    return versions


def validate_parameters(db, data):
    validate_policy(data)
    validate_deletions(db, data)
    namespace = set()
    for operation in data.operations:
        if not operation.enabled:
            continue
        if operation.type == "create_folder":
            name = library.valid_name(operation.params.name)
            parent_id = operation.params.parent_id
            key = (parent_id, library.normalized_name(name))
            if key in namespace:
                raise AppError("duplicate_folder", "计划在同一目录重复创建同名文件夹", 409)
            namespace.add(key)
            if not parent_id or not parent_id.startswith("ref:"):
                library.folder_name_conflict(db, data.kb_id, parent_id, name)
        elif operation.type in {"rename_document", "rename_folder"}:
            library.valid_name(operation.params.name, 160 if operation.type == "rename_folder" else 255)


def check_versions(db, data, lock=True):
    for key in references(data):
        resource = entity(db, key, data.kb_id, lock=lock)
        if key not in data.base_versions or resource.version != data.base_versions[key]:
            raise AppError("version_conflict", "审批期间资料发生了变化，请重新生成并审阅计划", 409,
                           {"resource": key, "current_version": resource.version})
    check_tag_links(db, data)


def store_operations(db, plan):
    db.execute(delete(AgentPlanOperation).where(AgentPlanOperation.plan_id == plan.id))
    for operation in plan.payload["operations"]:
        db.add(AgentPlanOperation(plan_id=plan.id, operation_id=operation["operation_id"],
                                  payload=operation, status="pending" if operation["enabled"] else "skipped"))


def persist_plan(db, actor, run, draft: PlanDraft, observed=None, observed_tag_usage=None, organization=None):
    assert_can_edit_kb(db, actor, run.kb_id)
    if run.status == "cancelled":
        raise AppError("invalid_run_state", "已取消的整理任务不能生成或批准计划", 409)
    existing = db.scalar(select(AgentPlan).where(AgentPlan.run_id == run.id))
    if existing:
        return existing
    tag_links = capture_tag_links(db, run.kb_id, draft)
    if observed_tag_usage is not None and any(len(ids) != observed_tag_usage.get(tag_id) for tag_id, ids in tag_links.items()):
        raise AppError("version_conflict", "规划期间标签使用数量已变化，请重新生成并审阅计划", 409)
    data = AgentPlanData(kb_id=run.kb_id, goal=run.goal, **draft.model_dump(), base_tag_links=tag_links, organization=organization,
                         base_versions=capture_versions(db, run.kb_id, draft, observed, tag_links))
    validate_parameters(db, data)
    plan = AgentPlan(id=data.plan_id, run_id=run.id, kb_id=run.kb_id,
                     payload=data.model_dump(mode="json"), status="pending_review")
    db.add(plan)
    db.flush()
    store_operations(db, plan)
    run.status = "pending_review"
    emit_event(db, run.id, "plan_ready", {"message": "整理计划已生成，请审阅后一次批准", "plan_id": plan.id})
    emit_event(db, run.id, "approval_required", {"message": "等待整批审批", "plan_id": plan.id})
    return plan


def edit_plan(db, actor, plan_id, edit: PlanEdit):
    plan, _ = lock_plan_namespace(db, actor, plan_id)
    if plan.status != "pending_review":
        raise AppError("invalid_plan_state", "只有待审批计划可以修改", 409)
    library.version_check(plan, edit.version)
    previous = AgentPlanData.model_validate(plan.payload)
    check_versions(db, previous)
    original_types = {op.operation_id: op.type for op in previous.operations}
    if any(original_types.get(op.operation_id) != op.type for op in edit.operations):
        raise AppError("invalid_plan_edit", "编辑不能更换操作类型或添加未经规划的操作")
    draft = PlanDraft(summary=edit.summary or previous.summary, operations=edit.operations)
    # Destructive targets are review authority, not a free-form metadata editor.
    original_targets = {op.operation_id: set(op.target_ids) for op in previous.operations}
    if any(op.type in {"delete_tags", "trash_empty_folders"} and
           not set(op.target_ids) <= original_targets[op.operation_id] for op in draft.operations):
        raise AppError("invalid_plan_edit", "删除操作只能保留或取消原方案目标，不能添加其他目标", 409)
    tag_links = capture_tag_links(db, plan.kb_id, draft, previous.base_tag_links)
    data = AgentPlanData(**{**previous.model_dump(), **draft.model_dump(),
                           "base_tag_links": tag_links,
                           "base_versions": capture_versions(db, plan.kb_id, draft, previous.base_versions, tag_links)})
    validate_parameters(db, data)
    plan.payload = data.model_dump(mode="json")
    plan.version += 1
    store_operations(db, plan)
    emit_event(db, plan.run_id, "status", {"message": "已保存编辑后的完整计划", "plan_version": plan.version})
    return plan


def _snapshot(db, kind, value):
    return library.document_snapshot(db, value) if kind == "document" else library.snapshot(value)


def execute_plan(db, actor, plan_id, plan_version, confirm_high_risk=False):
    """Caller commits this one transaction. Replays return its durable result."""
    plan, run = lock_plan_namespace(db, actor, plan_id)
    if run.status == "cancelled":
        raise AppError("invalid_run_state", "已取消的整理任务不能批准执行", 409)
    if plan.status == "completed":
        library.version_check(plan, plan_version)
        return plan.result
    if plan.status != "pending_review":
        raise AppError("invalid_plan_state", "此计划已拒绝、已撤销或正在执行", 409)
    library.version_check(plan, plan_version)
    data = AgentPlanData.model_validate(plan.payload)
    check_versions(db, data)
    validate_parameters(db, data)
    if data.risk_level == "high" and not confirm_high_risk:
        raise AppError("high_risk_confirmation_required", f"此计划包含删除操作，影响 {data.expected_changes} 项；删除标签会移除关联，请额外确认", 409)
    plan.status, run.status = "executing", "executing"
    plan.approved_by, plan.approved_at = actor.id, utcnow()
    emit_event(db, run.id, "status", {"message": "正在执行已批准的最终计划"})
    initial: dict[str, dict] = {}
    changed = {}
    temporary_folders = {}
    results = []

    def remember(kind, value, created=False, tags_only=False):
        key = f"{kind}:{value.id}"
        if key not in initial:
            initial[key] = {"created": True} if created else _snapshot(db, kind, value)
            if tags_only:
                initial[key]["tags_only"] = True
        elif not tags_only:
            initial[key].pop("tags_only", None)
        changed[key] = value

    def resolve_folder(folder_id):
        if folder_id and folder_id.startswith("ref:"):
            value = temporary_folders.get(folder_id[4:])
            if not value:
                raise AppError("invalid_dependency", "计划引用的新文件夹尚未创建")
            return value
        return folder_id

    for operation in data.operations:
        row = db.scalar(select(AgentPlanOperation).where(AgentPlanOperation.plan_id == plan.id,
                                                        AgentPlanOperation.operation_id == operation.operation_id))
        if not operation.enabled:
            if row:
                row.status = "skipped"
            continue
        emit_event(db, run.id, "tool_start", {"message": operation.description, "operation_id": operation.operation_id})
        affected = []
        if operation.type == "create_folder":
            folder = library.create_folder(db, actor, plan.kb_id, {"name": operation.params.name,
                                            "parent_id": resolve_folder(operation.params.parent_id)})
            temporary_folders[operation.operation_id] = folder.id
            remember("folder", folder, created=True)
            affected.append(("folder", folder, {}))
        elif operation.type == "rename_folder":
            folder = entity(db, f"folder:{operation.target_ids[0]}", plan.kb_id, lock=True)
            before = _snapshot(db, "folder", folder)
            remember("folder", folder)
            library.update_folder(db, actor, folder.id, {"name": operation.params.name})
            affected.append(("folder", folder, before))
        elif operation.type == "trash_empty_folders":
            for folder_id in operation.target_ids:
                folder = entity(db, f"folder:{folder_id}", plan.kb_id, lock=True)
                # Fresh final check under the namespace lock, never recursive.
                require_empty_folder(db, plan.kb_id, folder.id, strict=bool(data.organization))
                before = _snapshot(db, "folder", folder)
                remember("folder", folder)
                folder.deleted_at, folder.version = utcnow(), folder.version + 1
                affected.append(("folder", folder, before))
        elif operation.type == "delete_tags":
            for tag_id in operation.target_ids:
                tag = entity(db, f"tag:{tag_id}", plan.kb_id, lock=True)
                before = _snapshot(db, "tag", tag)
                remember("tag", tag)
                initial[f"tag:{tag.id}"] = {"deleted": True, "tag": initial[f"tag:{tag.id}"]}
                document_ids = list(db.scalars(select(DocumentTag.document_id).where(
                    DocumentTag.kb_id == plan.kb_id, DocumentTag.tag_id == tag.id).order_by(DocumentTag.document_id)))
                for document_id in document_ids:
                    document = entity(db, f"document:{document_id}", plan.kb_id, lock=True, include_deleted=True)
                    document_before = _snapshot(db, "document", document)
                    remember("document", document, tags_only=True)
                    library.update_document(db, actor, document.id, {"tag_ids": [tag.id], "tag_mode": "remove"})
                    affected.append(("document", document, document_before))
                # All document associations are gone before deleting this metadata row.
                tag.version += 1
                db.add(AuditLog(actor_id=actor.id, kb_id=plan.kb_id, run_id=run.id, plan_id=plan.id,
                    operation_id=operation.operation_id, action="delete_tags", entity_id=tag.id,
                    before=before, after={"removed": True, "affected_document_ids": document_ids}))
                db.delete(tag)
                db.flush()
        else:
            tag_ids = []
            if operation.type == "update_document_tags":
                tag_ids = list(operation.params.tag_ids)
                for name in operation.params.new_tag_names:
                    normalized = library.normalized_name(name)
                    tags = list(db.scalars(select(Tag).where(Tag.kb_id == plan.kb_id)))
                    tag = next((t for t in tags if normalized == t.normalized_name or normalized in
                                {library.normalized_name(alias) for alias in t.aliases}), None)
                    if not tag:
                        tag = Tag(kb_id=plan.kb_id, name=library.valid_name(name, 80), normalized_name=normalized)
                        db.add(tag)
                        db.flush()
                        remember("tag", tag, created=True)
                        db.add(AuditLog(actor_id=actor.id, kb_id=plan.kb_id, run_id=run.id, plan_id=plan.id,
                                        operation_id=operation.operation_id, action="create_tag", entity_id=tag.id,
                                        before={}, after=library.snapshot(tag)))
                    tag_ids.append(tag.id)
            for document_id in operation.target_ids:
                document = entity(db, f"document:{document_id}", plan.kb_id, lock=True)
                before = _snapshot(db, "document", document)
                remember("document", document)
                if operation.type == "move_documents":
                    changes = {"folder_id": resolve_folder(operation.params.folder_id)}
                elif operation.type == "rename_document":
                    changes = {"display_name": operation.params.name}
                elif operation.type == "trash_documents":
                    changes = {"deleted_at": True}
                else:
                    changes = {"tag_ids": tag_ids, "tag_mode": operation.params.mode}
                library.update_document(db, actor, document.id, changes)
                affected.append(("document", document, before))
        for kind, value, before in affected:
            db.add(AuditLog(actor_id=actor.id, kb_id=plan.kb_id, run_id=run.id, plan_id=plan.id,
                            operation_id=operation.operation_id, action=operation.type, entity_id=value.id,
                            before=before, after=_snapshot(db, kind, value)))
        if row:
            row.status = "completed"
        results.append({"operation_id": operation.operation_id, "type": operation.type, "status": "completed",
                        "affected_ids": list(dict.fromkeys([value.id for _, value, _ in affected] +
                            (operation.target_ids if operation.type == "delete_tags" else [])))})
        emit_event(db, run.id, "tool_end", {"message": f"已完成：{operation.description}", "operation_id": operation.operation_id})
    db.flush()
    for key, before in initial.items():
        kind, entity_id = key.split(":", 1)
        db.add(UndoRecord(run_id=run.id, entity_type=kind, entity_id=entity_id, before=before,
                          after_version=changed[key].version))
    plan.status, run.status = "completed", "completed"
    plan.payload = {**plan.payload, "status": "completed"}
    plan.result = {"operations": results, "affected_count": len(initial), "undo_available": bool(initial)}
    emit_event(db, run.id, "completed", {"message": "整理完成，可撤销此次整理", **plan.result})
    db.flush()
    return plan.result


def reject_plan(db, actor, plan_id):
    plan, run = lock_plan_namespace(db, actor, plan_id)
    if plan.status == "rejected":
        return plan
    if plan.status != "pending_review":
        raise AppError("invalid_plan_state", "此计划不能再拒绝", 409)
    plan.status = "rejected"
    plan.payload = {**plan.payload, "status": "rejected"}
    run.status = "rejected"
    emit_event(db, run.id, "completed", {"message": "已拒绝计划，资料未发生修改", "status": "rejected"})
    return plan


def undo_run(db, actor, run_id):
    located = get_run(db, actor, run_id)
    library.lock_kb_namespace(db, actor, located.kb_id)
    run = get_run(db, actor, run_id, lock=True)
    if run.status == "undone":
        return {"status": "undone"}
    if run.status != "completed":
        raise AppError("invalid_run_state", "只有已完成的整理可以撤销", 409)
    records = list(db.scalars(select(UndoRecord).where(UndoRecord.run_id == run.id,
                        UndoRecord.status == "available").order_by(UndoRecord.created_at.desc(), UndoRecord.id.desc()).with_for_update()))
    if not records:
        raise AppError("nothing_to_undo", "没有可撤销的操作", 409)
    values = {}
    deleted_tags = check_deleted_tag_restore(db, run.kb_id, records)
    restoring_tag_ids = {record.entity_id for record in deleted_tags}
    restoring_folder_ids = {record.entity_id for record in records if record.entity_type == "folder"
                            and not record.before.get("created") and not record.before.get("deleted_at")}
    for record in records:
        key = f"{record.entity_type}:{record.entity_id}"
        if record in deleted_tags:
            continue
        value = entity(db, key, run.kb_id, lock=True, include_deleted=True)
        if value.version != record.after_version:
            raise AppError("undo_conflict", "整理后已有人工修改，无法安全撤销；未覆盖任何后续更改", 409,
                           {"resource": key})
        if record.entity_type == "document":
            if (record.before.get("folder_id") and not record.before.get("tags_only")
                    and record.before["folder_id"] not in restoring_folder_ids):
                library.validate_folder(db, run.kb_id, record.before["folder_id"])
            for tag_id in record.before.get("tag_ids", []):
                if tag_id not in restoring_tag_ids:
                    entity(db, f"tag:{tag_id}", run.kb_id, lock=True)
        values[key] = value
    for record in deleted_tags:
        tag = restore_deleted_tag(db, record)
        record.status = "used"
        db.add(AuditLog(actor_id=actor.id, kb_id=run.kb_id, run_id=run.id, action="undo",
                        entity_id=record.entity_id, before={"removed": True}, after=library.snapshot(tag)))
    folder_before = {record.entity_id: record.before for record in records if record.entity_type == "folder"}

    def restore_order(record):
        # Original folders (parents first) must exist before their documents
        # return. Newly created metadata is removed only after documents return.
        depth, current, seen = 0, record.before.get("parent_id"), set()
        while current in folder_before and current not in seen:
            seen.add(current)
            depth += 1
            current = folder_before[current].get("parent_id")
        return (record.before.get("created", False),
                0 if record.entity_type == "folder" else 1 if record.entity_type == "document" else 2, depth)

    ordered = sorted([record for record in records if record not in deleted_tags],
                     key=restore_order)
    for record in ordered:
        value = values[f"{record.entity_type}:{record.entity_id}"]
        before_undo = _snapshot(db, record.entity_type, value)
        if record.before.get("created"):
            if record.entity_type == "folder":
                has_docs = db.scalar(select(Document.id).where(Document.folder_id == value.id).limit(1))
                child_ids = list(db.scalars(select(Folder.id).where(Folder.parent_id == value.id, Folder.deleted_at.is_(None))))
                planned_children = {r.entity_id for r in records if r.entity_type == "folder" and r.before.get("created")}
                if has_docs or set(child_ids) - planned_children:
                    raise AppError("undo_conflict", "新建目录中已有后续添加的资料，不能安全撤销", 409)
                value.deleted_at = utcnow()
                value.version += 1
            elif record.entity_type == "tag":
                if db.scalar(select(DocumentTag.document_id).where(DocumentTag.tag_id == value.id).limit(1)):
                    raise AppError("undo_conflict", "新建标签已有后续关联，不能安全撤销", 409)
                db.delete(value)
        elif record.entity_type == "document":
            changes = {"tag_ids": record.before.get("tag_ids", [])}
            if not record.before.get("tags_only"):
                changes.update(display_name=record.before["display_name"], folder_id=record.before["folder_id"],
                               deleted_at=bool(record.before.get("deleted_at")))
            library.update_document(db, actor, value.id, changes)
        elif record.entity_type == "folder":
            restore_folder(db, actor, value, record.before)
        record.status = "used"
        db.add(AuditLog(actor_id=actor.id, kb_id=run.kb_id, run_id=run.id, action="undo",
                        entity_id=record.entity_id, before=before_undo,
                        after={"removed": True} if record.entity_type == "tag" and record.before.get("created") else _snapshot(db, record.entity_type, value)))
        db.flush()
    run.status = "undone"
    plan = db.scalar(select(AgentPlan).where(AgentPlan.run_id == run.id))
    if plan:
        plan.status = "undone"
        plan.result = {**plan.result, "undo_available": False}
    emit_event(db, run.id, "completed", {"message": "已撤销此次整理", "status": "undone"})
    return {"status": "undone", "restored_count": len(records)}
