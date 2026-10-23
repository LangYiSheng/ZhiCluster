"""Unified suggestion approval using the same versioned plan executor and undo."""

from pydantic import ValidationError
from sqlalchemy import exists, func, or_, select

from app.agent.executor import execute_plan, persist_plan
from app.agent.plans import PlanDraft
from app.core.errors import AppError
from app.db.models import (
    AgentRun,
    ClassificationSuggestion,
    Document,
    DocumentTag,
    Folder,
    IngestionJob,
    KnowledgeBase,
    KnowledgeBaseMember,
    Tag,
    new_id,
)
from app.ingestion.enrichment import ClassificationResult
from app.services import library
from app.services.permissions import accessible_kb_ids, assert_can_edit_kb, assert_can_read_kb


def folder_paths(folders):
    by_id = {folder.id: folder for folder in folders}
    paths = {}

    def path(folder_id, seen=frozenset()):
        if folder_id is None:
            return "知识库根目录"
        if folder_id in paths:
            return paths[folder_id]
        folder = by_id.get(folder_id)
        if not folder or folder_id in seen:
            return "已删除或不可访问的文件夹"
        parent = path(folder.parent_id, seen | {folder_id}) if folder.parent_id else ""
        paths[folder_id] = f"{parent}/{folder.name}" if parent else folder.name
        return paths[folder_id]

    for folder in folders:
        path(folder.id)
    paths[None] = "知识库根目录"
    return paths


def list_suggestions(db, actor, *, kb_id=None, document_id=None, status="pending", page=1, page_size=30):
    allowed = accessible_kb_ids(db, actor)
    if kb_id:
        assert_can_read_kb(db, actor, kb_id)
        allowed = [kb_id]
    if document_id:
        doc = library.get_document(db, actor, document_id)
        if doc.kb_id not in allowed:
            raise AppError("scope_mismatch", "文档不属于所选知识库", 400)
    base = select(ClassificationSuggestion, Document, KnowledgeBase).join(
        Document, Document.id == ClassificationSuggestion.document_id,
    ).join(KnowledgeBase, KnowledgeBase.id == Document.kb_id).where(
        Document.kb_id.in_(allowed), ClassificationSuggestion.kb_id == Document.kb_id,
        Document.deleted_at.is_(None), KnowledgeBase.deleted_at.is_(None),
        or_(Document.folder_id.is_(None), exists(select(Folder.id).where(
            Folder.id == Document.folder_id, Folder.deleted_at.is_(None),
        ))),
    )
    if document_id:
        base = base.where(Document.id == document_id)
    counts = dict(db.execute(base.with_only_columns(ClassificationSuggestion.status, func.count())
                             .group_by(ClassificationSuggestion.status)).all())
    filtered = base.where(ClassificationSuggestion.status == status) if status != "all" else base
    total = db.scalar(select(func.count()).select_from(filtered.subquery())) or 0
    rows = list(db.execute(filtered.order_by(ClassificationSuggestion.created_at.desc(), ClassificationSuggestion.id)
                           .offset((page - 1) * page_size).limit(page_size)))
    folders = list(db.scalars(select(Folder).where(Folder.kb_id.in_(allowed), Folder.deleted_at.is_(None))))
    paths = folder_paths(folders)
    folder_kbs = {folder.id: folder.kb_id for folder in folders}
    tags = {tag.id: tag for tag in db.scalars(select(Tag).where(Tag.kb_id.in_(allowed)))}
    editable = set(db.scalars(select(KnowledgeBaseMember.kb_id).where(
        KnowledgeBaseMember.user_id == actor.id, KnowledgeBaseMember.kb_id.in_(allowed),
        KnowledgeBaseMember.role.in_(["owner", "editor"]),
    )))
    items = []
    refresh_rows = select(IngestionJob.document_id, IngestionJob.id, IngestionJob.status, IngestionJob.error,
        func.row_number().over(partition_by=IngestionJob.document_id,
            order_by=(IngestionJob.created_at.desc(), IngestionJob.id.desc())).label("position"),
    ).where(IngestionJob.kind == "ingest", IngestionJob.payload["review_suggestion_id"].as_string().in_([row[0].id for row in rows])).subquery()
    refresh_jobs = {row.document_id: row for row in db.execute(select(refresh_rows).where(refresh_rows.c.position == 1))}
    for item, doc, kb in rows:
        payload = item.payload
        destination = payload.get("existing_folder_id")
        target = paths.get(destination, "已删除或不可访问的文件夹") if destination else payload.get("proposed_folder_path") or paths[None]
        if destination and folder_kbs.get(destination) != kb.id:
            target = "已删除或不可访问的文件夹"
        items.append({
            **library.snapshot(item), "suggestion_id": item.id, "document_name": doc.display_name,
            "kb_name": kb.name, "current_version": doc.version,
            "conflict": item.document_version != doc.version, "document_available": True,
            "can_edit": kb.id in editable, "current_folder_path": paths.get(doc.folder_id, "已删除或不可访问的文件夹"),
            "target_folder_path": target,
            "existing_tag_names": [tags[tag_id].name for tag_id in payload.get("existing_tag_ids", [])
                                   if tag_id in tags and tags[tag_id].kb_id == kb.id],
            "refresh_job_id": refresh_jobs[doc.id].id if doc.id in refresh_jobs else None,
            "refresh_status": refresh_jobs[doc.id].status if doc.id in refresh_jobs else None,
            "refresh_error": refresh_jobs[doc.id].error if doc.id in refresh_jobs else None,
        })
    return {"items": items, "total": total, "page": page, "page_size": page_size,
            "counts": {key: counts.get(key, 0) for key in ("pending", "applied", "rejected")}}


def classification_draft(db, doc, payload):
    operations = []
    folder_id = payload.get("existing_folder_id")
    library.validate_folder(db, doc.kb_id, folder_id)
    if not folder_id and payload.get("proposed_folder_path"):
        parent, dependency = None, None
        for part in payload["proposed_folder_path"].split("/"):
            name = part.strip()
            if not name:
                continue
            name = library.valid_name(name)
            existing = None if dependency else next((folder for folder in db.scalars(select(Folder).where(
                Folder.kb_id == doc.kb_id, Folder.parent_id == parent, Folder.deleted_at.is_(None),
            )) if library.normalized_name(folder.name) == library.normalized_name(name)), None)
            if existing:
                parent = existing.id
            else:
                operation_id = f"folder-{len(operations) + 1}"
                operations.append({"type": "create_folder", "operation_id": operation_id,
                    "description": f"新建文件夹“{name}”", "params": {"name": name, "parent_id": parent},
                    "dependencies": [dependency] if dependency else []})
                parent, dependency = f"ref:{operation_id}", operation_id
        folder_id = parent
    else:
        dependency = None
    if folder_id != doc.folder_id:
        operations.append({"type": "move_documents", "operation_id": "move", "target_ids": [doc.id],
         "description": f"应用“{doc.display_name}”的文件夹建议", "params": {"folder_id": folder_id},
         "dependencies": [dependency] if dependency else []})
    chosen = set(payload.get("existing_tag_ids", []))
    if len(list(db.scalars(select(Tag.id).where(Tag.id.in_(chosen), Tag.kb_id == doc.kb_id)))) != len(chosen):
        raise AppError("invalid_tags", "建议引用的标签不存在或属于其他知识库", 409)
    current_tags = set(db.scalars(select(DocumentTag.tag_id).where(DocumentTag.document_id == doc.id)))
    names = list(payload.get("new_tag_names", []))
    if chosen - current_tags or names:
        operations.append({"type": "update_document_tags", "operation_id": "tags", "target_ids": [doc.id],
         "description": f"应用“{doc.display_name}”的标签建议",
         "params": {"mode": "add", "tag_ids": sorted(chosen - current_tags), "new_tag_names": names}})
    return PlanDraft(summary="应用已审阅的入库分类建议", operations=operations) if operations else None


def decide_suggestion(db, actor, suggestion_id, decision):
    original = db.get(ClassificationSuggestion, suggestion_id)
    if not original:
        raise AppError("not_found", "分类建议不存在", 404)
    assert_can_edit_kb(db, actor, original.kb_id)
    # All mutations use namespace -> suggestion -> document/plan lock order.
    library.lock_kb_namespace(db, actor, original.kb_id)
    item = db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.id == suggestion_id)
                     .with_for_update().execution_options(populate_existing=True))
    if not item or item.status != "pending":
        raise AppError("not_pending", "此建议已处理，请刷新列表", 409)
    db.get(Document, item.document_id, populate_existing=True)
    doc = library.get_document(db, actor, item.document_id)
    if doc.kb_id != item.kb_id:
        raise AppError("invalid_suggestion_resource", "建议与文档不属于同一知识库", 409)
    if decision.action == "reject":
        item.status = "rejected"
        library.audit(db, actor, doc.kb_id, "reject_classification", doc.id, {"suggestion_id": item.id}, {"status": item.status})
        return {"suggestion_id": item.id, "document_id": doc.id, "status": "rejected"}
    library.version_check(doc, decision.document_version)
    library.version_check(doc, item.document_version)
    try:
        payload = ClassificationResult.model_validate(decision.payload if decision.payload is not None else item.payload).model_dump()
        draft = classification_draft(db, doc, payload)
    except (ValidationError, ValueError) as error:
        raise AppError("invalid_suggestion", "分类建议格式无效，请修改建议后重试", 422) from error
    if not draft:
        item.payload, item.status = payload, "applied"
        library.audit(db, actor, doc.kb_id, "apply_classification", doc.id, {"suggestion_id": item.id}, {"status": item.status, "changed": False})
        return {"suggestion_id": item.id, "document_id": doc.id, "status": "applied", "undo_available": False}
    run = AgentRun(kb_id=doc.kb_id, actor_id=actor.id, thread_id=new_id(), goal=f"应用入库分类建议：{doc.display_name}")
    db.add(run)
    db.flush()
    plan = persist_plan(db, actor, run, draft, {f"document:{doc.id}": item.document_version})
    result = execute_plan(db, actor, plan.id, plan.version)
    item.payload, item.status = payload, "applied"
    return {"suggestion_id": item.id, "document_id": doc.id, "status": "applied", "run_id": run.id,
            "undo_available": result["undo_available"]}


def refresh_suggestion(db, actor, suggestion_id, document_version):
    original = db.get(ClassificationSuggestion, suggestion_id)
    if not original:
        raise AppError("not_found", "分类建议不存在", 404)
    assert_can_edit_kb(db, actor, original.kb_id)
    library.lock_kb_namespace(db, actor, original.kb_id)
    item = db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.id == suggestion_id)
                     .with_for_update().execution_options(populate_existing=True))
    if not item or item.status != "pending":
        raise AppError("not_pending", "只有待审阅的建议可以重新生成", 409)
    db.get(Document, item.document_id, populate_existing=True)
    doc = library.get_document(db, actor, item.document_id)
    if doc.kb_id != item.kb_id:
        raise AppError("invalid_suggestion_resource", "建议与文档不属于同一知识库", 409)
    library.version_check(doc, document_version)
    active = db.scalar(select(IngestionJob.id).where(IngestionJob.document_id == doc.id,
        IngestionJob.kind.in_(["ingest", "reindex"]), IngestionJob.status.in_(["queued", "running", "processing", "retry_wait"])))
    if active:
        raise AppError("document_busy", "此文档已有处理任务，请等待完成后重试", 409)
    doc.classification_status = "queued"
    job = IngestionJob(kb_id=doc.kb_id, document_id=doc.id, kind="ingest",
        payload={"review_suggestion_id": item.id, "classification_only": True})
    db.add(job)
    db.flush()
    return {"suggestion_id": item.id, "document_id": doc.id, "job_id": job.id, "status": "queued"}


def plan_preview(db, plan):
    operations = plan.payload.get("operations", [])
    folders = list(db.scalars(select(Folder).where(Folder.kb_id == plan.kb_id, Folder.deleted_at.is_(None))))
    paths = folder_paths(folders)
    target_ids = {target for operation in operations for target in operation.get("target_ids", [])}
    docs = {doc.id: doc for doc in db.scalars(select(Document).where(Document.kb_id == plan.kb_id, Document.id.in_(target_ids), Document.deleted_at.is_(None),
        or_(Document.folder_id.is_(None), Document.folder_id.in_(paths))))}
    by_folder = {folder.id: folder for folder in folders}
    result = []
    for operation in operations:
        params = operation.get("params", {})
        if operation["type"] == "create_folder":
            parent = params.get("parent_id")
            paths[f"ref:{operation['operation_id']}"] = f"{paths.get(parent, '已删除或不可访问的文件夹')}/{params['name']}" if parent else params["name"]
        destination = params.get("folder_id")
        targets = []
        for target in operation.get("target_ids", []):
            resource = by_folder.get(target) if operation["type"] == "rename_folder" else docs.get(target)
            targets.append({"id": target, "name": resource.name if isinstance(resource, Folder) else resource.display_name if resource else "已删除或不可访问",
                            "kind": "folder" if operation["type"] == "rename_folder" else "document", "available": resource is not None,
                            "folder_path": paths.get(getattr(resource, "folder_id", None), "已删除或不可访问的文件夹")})
        result.append({"operation_id": operation["operation_id"], "targets": targets,
                       "destination_path": paths.get(destination, "已删除或不可访问的文件夹") if operation["type"] == "move_documents" else None})
    return result
