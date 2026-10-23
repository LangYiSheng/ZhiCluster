from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session, aliased

from app.db.models import Document, IngestionJob, JobEvent, utcnow


def emit(db: Session, job: IngestionJob, event_type: str, data: dict[str, Any]) -> JobEvent:
    sequence = (db.scalar(select(func.max(JobEvent.sequence)).where(JobEvent.job_id == job.id)) or 0) + 1
    event = JobEvent(job_id=job.id, sequence=sequence, type=event_type, data=data)
    db.add(event)
    return event


def claim_job(db: Session, owner: str, lease_seconds: int = 180, max_attempts: int = 3, *, kinds: tuple[str, ...] | None = None) -> IngestionJob | None:
    now = utcnow()
    due = or_(IngestionJob.next_attempt_at.is_(None), IngestionJob.next_attempt_at <= now)
    available = or_(
        and_(IngestionJob.status.in_(["queued", "retry_wait"]), due),
        and_(IngestionJob.status == "running", IngestionJob.lease_until < now),
    )
    sibling = aliased(IngestionJob)
    same_document_busy = select(sibling.id).where(
        sibling.document_id == IngestionJob.document_id,
        sibling.id != IngestionJob.id,
        sibling.status == "running",
        sibling.lease_until >= now,
    ).exists()
    filters = [available, IngestionJob.attempts < max_attempts, ~same_document_busy]
    if kinds is not None:
        filters.append(IngestionJob.kind.in_(kinds))
    candidates = db.scalars(select(IngestionJob).where(*filters).order_by(
        IngestionJob.created_at, IngestionJob.id,
    ).with_for_update(skip_locked=True).limit(16)).all()
    job = None
    for candidate in candidates:
        # Serialize competing ingest/reindex claims for the same document,
        # including two workers claiming different job rows simultaneously.
        if candidate.document_id:
            if db.scalar(select(Document.id).where(
                Document.id == candidate.document_id,
            ).with_for_update(skip_locked=True)) is None:
                continue
            # The candidate statement precedes this document lock. Another
            # worker can claim a different job for the same document between
            # those statements, then release the document lock at its commit.
            # Recheck under the lock using a fresh READ COMMITTED snapshot.
            competing = db.scalar(select(IngestionJob.id).where(
                IngestionJob.document_id == candidate.document_id,
                IngestionJob.id != candidate.id,
                IngestionJob.status == "running",
                IngestionJob.lease_until >= utcnow(),
            ).limit(1))
            if competing is not None:
                continue
        job = candidate
        break
    if job is None:
        # A worker that dies repeatedly must not strand a job in running forever.
        exhausted_query = select(IngestionJob).where(IngestionJob.status == "running", IngestionJob.lease_until < now, IngestionJob.attempts >= max_attempts)
        if kinds is not None:
            exhausted_query = exhausted_query.where(IngestionJob.kind.in_(kinds))
        exhausted = db.scalars(exhausted_query.with_for_update(skip_locked=True)).all()
        for item in exhausted:
            item.status = "failed"
            item.error = "任务多次租约过期，已停止自动重试；可手动重试"
            item.lease_owner = None
            item.lease_until = None
            emit(db, item, "error", {"message": item.error, "stage": item.stage})
        db.commit()
        return None
    was_recovered = job.status == "running"
    job.status = "running"
    job.lease_owner = owner
    job.lease_until = utcnow() + timedelta(seconds=lease_seconds)
    job.attempts += 1
    job.next_attempt_at = None
    emit(db, job, "status", {"status": "running", "attempt": job.attempts, "recovered": was_recovered})
    db.commit()
    return job


def heartbeat(db: Session, job_id: str, owner: str, lease_seconds: int) -> bool:
    result = db.execute(update(IngestionJob).where(IngestionJob.id == job_id, IngestionJob.status == "running", IngestionJob.lease_owner == owner).values(lease_until=utcnow() + timedelta(seconds=lease_seconds)))
    db.commit()
    return result.rowcount == 1
