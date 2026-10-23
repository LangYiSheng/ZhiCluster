"""Cross-library classification review and review-first metadata organization."""

from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import AppError
from app.db.models import AgentRun, ClassificationSuggestion, IngestionJob, new_id
from app.db.session import get_db
from app.schemas.review import (
    BatchSuggestionDecision,
    OrganizationRequest,
    SuggestionDecision,
    SuggestionRefresh,
)
from app.services import library
from app.services.permissions import assert_can_edit_kb, get_actor
from app.services.review import decide_suggestion, list_suggestions, refresh_suggestion
from app.services.runtime_config import get_runtime_settings

router = APIRouter(prefix="/api/review", tags=["review"])


@router.get("/suggestions")
def suggestions(kb_id: str | None = None, document_id: str | None = None,
                status: Literal["pending", "applied", "rejected", "all"] = "pending",
                page: int = Query(1, ge=1), page_size: int = Query(30, ge=1, le=100),
                db: Session = Depends(get_db, scope="function")):
    return list_suggestions(db, get_actor(db), kb_id=kb_id, document_id=document_id,
                            status=status, page=page, page_size=page_size)


@router.post("/suggestions/batch")
def batch_suggestions(body: BatchSuggestionDecision, db: Session = Depends(get_db, scope="function")):
    actor = get_actor(db)
    results = {}
    scopes = dict(db.execute(select(ClassificationSuggestion.id, ClassificationSuggestion.kb_id).where(
        ClassificationSuggestion.id.in_([item.suggestion_id for item in body.items]),
    )).all())
    # Successful savepoints retain namespace locks until the outer request
    # commits. A stable KB order prevents reversed cross-library batches from
    # waiting on each other's second namespace; preserve original response order.
    for item in sorted(body.items, key=lambda item: (scopes.get(item.suggestion_id, ""), item.suggestion_id)):
        try:
            with db.begin_nested():
                result = decide_suggestion(db, actor, item.suggestion_id,
                    SuggestionDecision(action=body.action, document_version=item.document_version, payload=item.payload))
            results[item.suggestion_id] = result
        except AppError as error:
            results[item.suggestion_id] = {"suggestion_id": item.suggestion_id,
                "status": "conflict" if error.status == 409 else "failed", "code": error.code,
                "message": error.message, "details": error.details}
        except IntegrityError:
            results[item.suggestion_id] = {"suggestion_id": item.suggestion_id, "status": "conflict", "code": "conflict",
                "message": "资料或目录发生了变化，请刷新后重试"}
    ordered = [results[item.suggestion_id] for item in body.items]
    succeeded = sum(item["status"] in {"applied", "rejected"} for item in ordered)
    return {"items": ordered, "succeeded": succeeded, "failed": len(ordered) - succeeded}


@router.post("/suggestions/{suggestion_id}")
def suggestion_decision(suggestion_id: str, body: SuggestionDecision, db: Session = Depends(get_db, scope="function")):
    return decide_suggestion(db, get_actor(db), suggestion_id, body)


@router.post("/suggestions/{suggestion_id}/refresh")
def regenerate_suggestion(suggestion_id: str, body: SuggestionRefresh, db: Session = Depends(get_db, scope="function")):
    return refresh_suggestion(db, get_actor(db), suggestion_id, body.document_version)


@router.post("/plans", status_code=201)
def create_organization_plan(body: OrganizationRequest, db: Session = Depends(get_db, scope="function")):
    from app.agent.organization import source_snapshot

    actor = get_actor(db)
    assert_can_edit_kb(db, actor, body.kb_id)
    library.lock_kb_namespace(db, actor, body.kb_id)
    if not get_runtime_settings(db, get_settings()).llm_configured:
        raise AppError("model_not_configured", "整理方案需要配置聊天模型，支持 JSON 输出即可", 503)
    # Fail a foreign/oversized scope before enqueueing or sending anything to a model.
    source, _ = source_snapshot(db, actor, body.kb_id, body.document_ids)
    if not source["documents"]:
        raise AppError("empty_scope", "此知识库没有可整理的文档", 400)
    existing = db.scalar(select(IngestionJob.id).where(IngestionJob.kb_id == body.kb_id,
        IngestionJob.kind == "organize", IngestionJob.status.in_(["queued", "running", "retry_wait"])))
    if existing:
        raise AppError("organization_busy", "此知识库已有方案正在生成，请等待当前任务完成", 409)
    run = AgentRun(kb_id=body.kb_id, actor_id=actor.id, thread_id=new_id(), goal=body.goal)
    db.add(run)
    db.flush()
    db.add(IngestionJob(kb_id=body.kb_id, kind="organize", payload={"run_id": run.id,
        "document_ids": [doc["id"] for doc in source["documents"]]}))
    return library.snapshot(run)
