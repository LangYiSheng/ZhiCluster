from __future__ import annotations

import logging
import signal
import socket
import threading
from uuid import uuid4

from app.core.config import get_settings
from app.db.models import IngestionJob
from app.db.session import SessionLocal
from app.worker.pipeline import process_ingestion_job
from app.worker.queue import claim_job, emit, heartbeat

logger = logging.getLogger(__name__)


def dispatch(job_id: str, kind: str, owner: str, settings, session_factory=SessionLocal) -> None:
    if kind in {"ingest", "reindex"}:
        process_ingestion_job(job_id, session_factory, settings, owner=owner)
    elif kind == "chat":
        from app.services.chat import process_chat_job

        process_chat_job(job_id, session_factory, settings, owner=owner)
    elif kind == "agent":
        from app.agent.service import process_agent_job

        process_agent_job(job_id, session_factory, settings, owner=owner)
    else:
        raise ValueError(f"Unsupported job kind: {kind}")


def run_worker() -> None:
    settings = get_settings()
    stop = threading.Event()
    owner = f"{socket.gethostname()}:{uuid4().hex[:12]}"
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    logger.info("Worker started: %s", owner)
    while not stop.is_set():
        try:
            with SessionLocal() as db:
                job = claim_job(db, owner, settings.job_lease_seconds, settings.max_ingestion_attempts)
                if job is None:
                    stop.wait(settings.worker_poll_seconds)
                    continue
                job_id, kind = job.id, job.kind
            pulse_stop = threading.Event()

            def pulse(pulse_stop=pulse_stop, job_id=job_id) -> None:
                while not pulse_stop.wait(max(1, settings.job_lease_seconds / 3)):
                    try:
                        with SessionLocal() as pulse_db:
                            if not heartbeat(pulse_db, job_id, owner, settings.job_lease_seconds):
                                return
                    except Exception:
                        logger.exception("Worker heartbeat failed for %s", job_id)

            pulse_thread = threading.Thread(target=pulse, daemon=True)
            pulse_thread.start()
            try:
                dispatch(job_id, kind, owner, settings)
            except Exception as error:
                logger.exception("Job failed: %s", job_id)
                with SessionLocal() as db:
                    failed = db.get(IngestionJob, job_id)
                    if failed and failed.lease_owner == owner:
                        failed.status = "failed"
                        failed.error = f"任务执行失败（{type(error).__name__}）"
                        failed.lease_owner = None
                        failed.lease_until = None
                        emit(db, failed, "error", {"message": failed.error})
                        db.commit()
            finally:
                pulse_stop.set()
                pulse_thread.join(timeout=2)
        except Exception:
            logger.exception("Worker queue poll failed")
            stop.wait(settings.worker_poll_seconds)
    logger.info("Worker stopped gracefully")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_worker()
