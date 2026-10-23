"""Owned recycle-bin queries and transactional, permanent deletion."""
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import OperationalError

from app.core.errors import AppError
from app.db.models import (
    AgentEvent,
    AgentPlan,
    AgentPlanOperation,
    AgentRun,
    AuditLog,
    ChunkEmbedding,
    ClassificationSuggestion,
    Document,
    DocumentChunk,
    DocumentSection,
    DocumentTag,
    Folder,
    IngestionJob,
    JobEvent,
    KnowledgeBase,
    KnowledgeBaseMember,
    MessageCitation,
    StorageDeletion,
    Tag,
    UndoRecord,
)


def _owned(actor_id):
    return select(KnowledgeBase.id).join(KnowledgeBaseMember, KnowledgeBaseMember.kb_id == KnowledgeBase.id).where(
        KnowledgeBase.owner_id == actor_id, KnowledgeBaseMember.user_id == actor_id,
        KnowledgeBaseMember.role == "owner",
    )


def list_trash(db, actor_id, kind, query, page, page_size):
    owned = _owned(actor_id)
    statements = {
        "document": select(Document, KnowledgeBase.name).join(KnowledgeBase, Document.kb_id == KnowledgeBase.id).where(
            KnowledgeBase.id.in_(owned), KnowledgeBase.deleted_at.is_(None), Document.deleted_at.is_not(None)),
        "folder": select(Folder, KnowledgeBase.name).join(KnowledgeBase, Folder.kb_id == KnowledgeBase.id).where(
            KnowledgeBase.id.in_(owned), KnowledgeBase.deleted_at.is_(None), Folder.deleted_at.is_not(None)),
        "knowledge_base": select(KnowledgeBase, KnowledgeBase.name).where(
            KnowledgeBase.id.in_(owned), KnowledgeBase.deleted_at.is_not(None)),
    }
    counts = {key: db.scalar(select(func.count()).select_from(stmt.subquery())) for key, stmt in statements.items()}
    model = {"document": Document, "folder": Folder, "knowledge_base": KnowledgeBase}[kind]
    stmt = statements[kind]
    if query.strip():
        name = Document.display_name if kind == "document" else model.name
        stmt = stmt.where(name.contains(query.strip(), autoescape=True))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    items = []
    rows = list(db.execute(stmt.order_by(model.deleted_at.desc(), model.id).offset((page - 1) * page_size).limit(page_size)))
    page_ids = [entity.id for entity, _ in rows]
    document_counts, folder_counts = {}, {}
    if kind == "knowledge_base" and page_ids:
        document_counts = dict(db.execute(select(Document.kb_id, func.count()).where(Document.kb_id.in_(page_ids)).group_by(Document.kb_id)).all())
        folder_counts = dict(db.execute(select(Folder.kb_id, func.count()).where(Folder.kb_id.in_(page_ids)).group_by(Folder.kb_id)).all())
    for entity, kb_name in rows:
        item = {"id": entity.id, "name": entity.display_name if kind == "document" else entity.name,
                "kb_id": entity.id if kind == "knowledge_base" else entity.kb_id,
                "kb_name": kb_name, "kind": kind, "deleted_at": entity.deleted_at}
        if kind == "knowledge_base":
            item["document_count"] = document_counts.get(entity.id, 0)
            item["folder_count"] = folder_counts.get(entity.id, 0)
        items.append(item)
    pending = db.scalar(select(func.count()).select_from(StorageDeletion).where(StorageDeletion.owner_id == actor_id))
    return {"items": items, "total": total, "counts": counts, "pending_file_cleanup": pending}


def _remove_documents(db, documents, actor_id):
    ids = [doc.id for doc in documents]
    if not ids:
        return
    chunks = select(DocumentChunk.id).where(DocumentChunk.document_id.in_(ids))
    jobs = select(IngestionJob.id).where(IngestionJob.document_id.in_(ids))
    db.execute(delete(MessageCitation).where(MessageCitation.document_id.in_(ids)))
    db.execute(delete(ChunkEmbedding).where(ChunkEmbedding.chunk_id.in_(chunks)))
    db.execute(delete(DocumentChunk).where(DocumentChunk.document_id.in_(ids)))
    db.execute(update(DocumentSection).where(DocumentSection.document_id.in_(ids)).values(parent_section_id=None))
    db.execute(delete(DocumentSection).where(DocumentSection.document_id.in_(ids)))
    db.execute(delete(ClassificationSuggestion).where(ClassificationSuggestion.document_id.in_(ids)))
    db.execute(delete(DocumentTag).where(DocumentTag.document_id.in_(ids)))
    db.execute(delete(JobEvent).where(JobEvent.job_id.in_(jobs)))
    db.execute(delete(IngestionJob).where(IngestionJob.document_id.in_(ids)))
    db.execute(delete(UndoRecord).where(UndoRecord.entity_id.in_(ids)))
    db.execute(delete(AuditLog).where(AuditLog.entity_id.in_(ids)))
    queued = set(db.scalars(select(StorageDeletion.storage_key).where(StorageDeletion.storage_key.in_([doc.storage_key for doc in documents]))))
    for doc in documents:
        if doc.storage_key not in queued:
            db.add(StorageDeletion(storage_key=doc.storage_key, owner_id=actor_id))
            queued.add(doc.storage_key)
    db.execute(delete(Document).where(Document.id.in_(ids)))


def purge_trash(db, actor_id, kind, ids):
    """Lock the namespace before checking state; never delete a running task."""
    owned_ids = list(db.scalars(_owned(actor_id)))
    bases = list(db.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(owned_ids)).order_by(KnowledgeBase.id).with_for_update()))
    deleted_bases = {base.id for base in bases if base.deleted_at}
    wanted = set(ids or [])
    if kind != "all" and not wanted:
        raise AppError("empty_selection", "请选择要永久删除的项目")
    all_folders = list(db.scalars(select(Folder).where(Folder.kb_id.in_(owned_ids))))
    base_ids = deleted_bases if kind == "all" else deleted_bases & wanted if kind == "knowledge_base" else set()
    folders = {folder.id for folder in all_folders if folder.kb_id in base_ids or (
        folder.deleted_at and folder.kb_id not in deleted_bases and (kind == "all" or kind == "folder" and folder.id in wanted))}
    # Include descendants, but reject inconsistent restored resources rather than
    # silently destroy content that is no longer in the recycle bin.
    while True:
        children = {folder.id for folder in all_folders if folder.parent_id in folders}
        if children.issubset(folders):
            break
        folders |= children
    document_condition = Document.kb_id.in_(base_ids) | Document.folder_id.in_(folders)
    if kind in {"all", "document"}:
        deleted_condition = Document.deleted_at.is_not(None) & Document.kb_id.not_in(deleted_bases)
        if kind == "document":
            deleted_condition &= Document.id.in_(wanted)
        document_condition |= deleted_condition
    docs = list(db.scalars(select(Document).where(Document.kb_id.in_(owned_ids), document_condition)))
    if any(not folder.deleted_at and folder.kb_id not in base_ids for folder in all_folders if folder.id in folders) or any(not doc.deleted_at and doc.kb_id not in base_ids for doc in docs):
        raise AppError("active_resource", "项目中存在已恢复的内容，请刷新后重试", 409)
    selected = {"document": {doc.id for doc in docs}, "folder": folders, "knowledge_base": base_ids}
    if kind != "all" and not wanted.issubset(selected[kind]):
        raise AppError("trash_not_found", "项目不存在、已恢复，或你没有管理权限", 404)
    doc_ids = [doc.id for doc in docs]
    try:
        # Approval/undo transactions take plan locks before namespace locks.
        # Fail promptly if they are active rather than create a waiting cycle.
        list(db.scalars(select(AgentPlan).where(AgentPlan.kb_id.in_(base_ids)).order_by(AgentPlan.id).with_for_update(nowait=True)))
        runs = list(db.scalars(select(AgentRun).where(AgentRun.kb_id.in_(base_ids)).order_by(AgentRun.id).with_for_update(nowait=True)))
        jobs = list(db.scalars(select(IngestionJob).where(
            (IngestionJob.document_id.in_(doc_ids)) | (IngestionJob.kb_id.in_(base_ids))
        ).order_by(IngestionJob.id).with_for_update(nowait=True)))
    except OperationalError as exc:
        db.rollback()
        raise AppError("trash_busy", "项目正在被其他任务使用，请稍后重试", 409) from exc
    if any(job.status == "running" for job in jobs) or any(run.status in {"running", "queued", "planning", "executing"} for run in runs):
        raise AppError("task_running", "仍有任务正在执行，请等待完成或在任务列表取消后重试", 409)
    _remove_documents(db, docs, actor_id)
    db.execute(delete(UndoRecord).where(UndoRecord.entity_id.in_(folders)))
    db.execute(delete(AuditLog).where(AuditLog.entity_id.in_(folders)))
    db.execute(update(Folder).where(Folder.id.in_(folders)).values(parent_id=None))
    db.execute(delete(Folder).where(Folder.id.in_(folders)))
    if base_ids:
        runs = select(AgentRun.id).where(AgentRun.kb_id.in_(base_ids))
        plans = select(AgentPlan.id).where(AgentPlan.kb_id.in_(base_ids))
        remaining_jobs = select(IngestionJob.id).where(IngestionJob.kb_id.in_(base_ids))
        db.execute(delete(AgentPlanOperation).where(AgentPlanOperation.plan_id.in_(plans)))
        db.execute(delete(AgentPlan).where(AgentPlan.kb_id.in_(base_ids)))
        db.execute(delete(AgentEvent).where(AgentEvent.run_id.in_(runs)))
        db.execute(delete(UndoRecord).where(UndoRecord.run_id.in_(runs)))
        db.execute(delete(AgentRun).where(AgentRun.kb_id.in_(base_ids)))
        db.execute(delete(JobEvent).where(JobEvent.job_id.in_(remaining_jobs)))
        db.execute(delete(IngestionJob).where(IngestionJob.kb_id.in_(base_ids)))
        db.execute(delete(AuditLog).where(AuditLog.kb_id.in_(base_ids)))
        db.execute(delete(Tag).where(Tag.kb_id.in_(base_ids)))
        db.execute(delete(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id.in_(base_ids)))
        db.execute(delete(KnowledgeBase).where(KnowledgeBase.id.in_(base_ids)))
    db.commit()
    return {"document": len(docs), "folder": len(folders), "knowledge_base": len(base_ids)}
