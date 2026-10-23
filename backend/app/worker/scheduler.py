"""Bounded job lanes; each claimed task owns its sessions and lease heartbeat."""

from __future__ import annotations

import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any
from uuid import uuid4

from app.db.models import IngestionJob
from app.worker.queue import claim_job, emit, heartbeat

logger = logging.getLogger(__name__)


def run_claimed_job(job_id: str, kind: str, owner: str, settings: Any, session_factory, dispatch) -> None:
    pulse_stop = threading.Event()

    def pulse() -> None:
        while not pulse_stop.wait(max(1, settings.job_lease_seconds / 3)):
            try:
                with session_factory() as db:
                    if not heartbeat(db, job_id, owner, settings.job_lease_seconds):
                        return
            except Exception:
                logger.exception("Worker heartbeat failed for %s", job_id)

    pulse_thread = threading.Thread(target=pulse, name=f"heartbeat-{job_id[:8]}", daemon=True)
    pulse_thread.start()
    try:
        dispatch(job_id, kind, owner, settings, session_factory)
    except Exception as error:
        logger.exception("Job failed: %s", job_id)
        with session_factory() as db:
            failed = db.get(IngestionJob, job_id)
            if failed and failed.status == "running" and failed.lease_owner == owner:
                failed.status = "failed"
                failed.error = f"任务执行失败（{type(error).__name__}）"
                failed.lease_owner = None
                failed.lease_until = None
                emit(db, failed, "error", {"message": failed.error})
                db.commit()
    finally:
        pulse_stop.set()
        pulse_thread.join(timeout=2)


class WorkerScheduler:
    def __init__(self, owner: str, settings: Any, session_factory, dispatch):
        self.owner = owner
        self.session_factory = session_factory
        self.dispatch = dispatch
        self.capacities = {
            "interactive": max(1, min(8, int(getattr(settings, "worker_interactive_concurrency", 1)))),
            "ingestion": max(1, min(16, int(getattr(settings, "worker_ingestion_concurrency", 3)))),
        }
        self.executors = {
            lane: ThreadPoolExecutor(max_workers=capacity, thread_name_prefix=f"worker-{lane}")
            for lane, capacity in self.capacities.items()
        }
        self.pending: dict[str, set[Future]] = {lane: set() for lane in self.capacities}
        self.closed = False

    def poll(self, settings: Any) -> int:
        if self.closed:
            return 0
        started = 0
        for lane, kinds in (("interactive", ("chat", "agent")), ("ingestion", ("ingest", "reindex"))):
            active = self.pending[lane]
            for future in list(active):
                if future.done():
                    active.remove(future)
                    try:
                        future.result()
                    except Exception:
                        logger.exception("Worker task wrapper failed")
            # Claim only when a thread is free: jobs never spend their lease
            # waiting inside an executor queue behind unrelated long work.
            while len(active) < self.capacities[lane]:
                task_owner = f"{self.owner}:{uuid4().hex[:8]}"
                with self.session_factory() as db:
                    job = claim_job(db, task_owner, settings.job_lease_seconds, settings.max_ingestion_attempts, kinds=kinds)
                    if job is None:
                        break
                    job_id, kind = job.id, job.kind
                active.add(self.executors[lane].submit(
                    run_claimed_job, job_id, kind, task_owner, settings, self.session_factory, self.dispatch,
                ))
                started += 1
        return started

    @property
    def busy(self) -> bool:
        return any(any(not task.done() for task in tasks) for tasks in self.pending.values())

    def shutdown(self) -> None:
        self.closed = True
        # Keep heartbeats alive until every already claimed task has finished.
        for executor in self.executors.values():
            executor.shutdown(wait=True, cancel_futures=False)
