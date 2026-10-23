from __future__ import annotations

import logging
import signal
import socket
import threading
from uuid import uuid4

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.runtime_config import get_runtime_settings
from app.worker.pipeline import process_ingestion_job
from app.worker.scheduler import WorkerScheduler

logger = logging.getLogger(__name__)


def dispatch(job_id: str, kind: str, owner: str, settings, session_factory=SessionLocal) -> None:
    if kind in {"ingest", "reindex"}:
        process_ingestion_job(job_id, session_factory, settings, owner=owner)
    elif kind == "organize":
        from app.agent.organization import process_organization_job

        process_organization_job(job_id, session_factory, settings, owner=owner)
    elif kind == "chat":
        from app.services.chat import process_chat_job

        process_chat_job(job_id, session_factory, settings, owner=owner)
    elif kind == "agent":
        from app.agent.service import process_agent_job

        process_agent_job(job_id, session_factory, settings, owner=owner)
    else:
        raise ValueError(f"Unsupported job kind: {kind}")


def run_worker() -> None:
    base_settings = get_settings()
    stop = threading.Event()
    owner = f"{socket.gethostname()}:{uuid4().hex[:12]}"
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    logger.info("Worker started: %s", owner)
    scheduler = WorkerScheduler(owner, base_settings, SessionLocal, dispatch)
    try:
        while not stop.is_set():
            try:
                with SessionLocal() as db:
                    settings = get_runtime_settings(db, base_settings)
                scheduler.poll(settings)
                stop.wait(min(settings.worker_poll_seconds, 0.25) if scheduler.busy else settings.worker_poll_seconds)
            except Exception:
                logger.exception("Worker queue poll failed")
                stop.wait(base_settings.worker_poll_seconds)
    finally:
        scheduler.shutdown()
    logger.info("Worker stopped gracefully")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_worker()
