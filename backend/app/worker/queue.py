from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session

from app.db.models import IngestionJob, JobEvent, utcnow


def emit(db: Session, job: IngestionJob, event_type: str, data: dict[str, Any]) -> JobEvent:
    sequence = (db.scalar(select(func.max(JobEvent.sequence)).where(JobEvent.job_id == job.id)) or 0) + 1
    event = JobEvent(job_id=job.id, sequence=sequence, type=event_type, data=data)
    db.add(event)
    return event


def claim_job(db: Session, owner: str, lease_seconds: int = 180, max_attempts: int = 3) -> IngestionJob | None:
    now = utcnow()
    due = or_(IngestionJob.next_attempt_at.is_(None), IngestionJob.next_attempt_at <= now)
    available = or_(
        and_(IngestionJob.status.in_(["queued", "retry_wait"]), due),
        and_(IngestionJob.status == "running", IngestionJob.lease_until < now),
    )
    job = db.scalar(select(IngestionJob).where(available, IngestionJob.attempts < max_attempts).order_by(IngestionJob.created_at).with_for_update(skip_locked=True).limit(1))
    if job is None:
        # A worker that dies repeatedly must not strand a job in running forever.
        exhausted = db.scalars(select(IngestionJob).where(IngestionJob.status == "running", IngestionJob.lease_until < now, IngestionJob.attempts >= max_attempts).with_for_update(skip_locked=True)).all()
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
    job.lease_until = now + timedelta(seconds=lease_seconds)
    job.attempts += 1
    job.next_attempt_at = None
    emit(db, job, "status", {"status": "running", "attempt": job.attempts, "recovered": was_recovered})
    db.commit()
    return job


def heartbeat(db: Session, job_id: str, owner: str, lease_seconds: int) -> bool:
    result = db.execute(update(IngestionJob).where(IngestionJob.id == job_id, IngestionJob.status == "running", IngestionJob.lease_owner == owner).values(lease_until=utcnow() + timedelta(seconds=lease_seconds)))
    db.commit()
    return result.rowcount == 1
