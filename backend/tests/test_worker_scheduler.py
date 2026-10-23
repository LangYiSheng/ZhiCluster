import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.db.models import Base, Document, IngestionJob, KnowledgeBase, User, utcnow
from app.worker.queue import claim_job
from app.worker.scheduler import WorkerScheduler, run_claimed_job


@pytest.fixture
def scheduled_jobs(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'scheduler.db'}", connect_args={"timeout": 10})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    settings = Settings(_env_file=None, worker_ingestion_concurrency=2, worker_interactive_concurrency=1)
    with factory() as db:
        actor = User(email="scheduler@example.test", display_name="Scheduler test")
        db.add(actor)
        db.flush()
        kb = KnowledgeBase(owner_id=actor.id, name="Queue test")
        db.add(kb)
        db.flush()
        document_ids = []
        for index in range(3):
            document = Document(kb_id=kb.id, owner_id=actor.id, display_name=f"doc-{index}.txt", original_filename=f"doc-{index}.txt", ext="txt", mime_type="text/plain", sha256="a" * 64, size_bytes=10, storage_key=str(Path("test") / str(index)))
            db.add(document)
            db.flush()
            document_ids.append(document.id)
            db.add(IngestionJob(kb_id=kb.id, document_id=document.id))
        chat = IngestionJob(kb_id=kb.id, kind="chat")
        db.add(chat)
        db.commit()
        yield factory, settings, kb.id, document_ids, chat.id
    engine.dispose()


def test_two_ingestion_jobs_and_chat_run_together_without_claiming_queued_work(scheduled_jobs):
    factory, settings, _, _, chat_id = scheduled_jobs
    release = threading.Event()
    all_started = threading.Event()
    lock = threading.Lock()
    started = []

    def dispatch(job_id, kind, owner, config, session_factory):
        assert session_factory is factory and config is settings
        with lock:
            started.append((job_id, kind, owner))
            if len(started) == 3:
                all_started.set()
        assert release.wait(3)
        with session_factory() as db:
            job = db.get(IngestionJob, job_id)
            assert job.lease_owner == owner
            job.status = "completed"
            job.lease_owner = job.lease_until = None
            db.commit()

    scheduler = WorkerScheduler("worker-test", settings, factory, dispatch)
    try:
        assert scheduler.poll(settings) == 3
        assert all_started.wait(2)
        assert {kind for _, kind, _ in started} == {"chat", "ingest"}
        assert chat_id in {job_id for job_id, _, _ in started}
        assert len({owner for _, _, owner in started}) == 3
        with factory() as db:
            queued = list(db.scalars(select(IngestionJob).where(IngestionJob.status == "queued")))
            assert len(queued) == 1
            assert queued[0].attempts == 0 and queued[0].lease_owner is None
        assert scheduler.poll(settings) == 0
    finally:
        release.set()
        scheduler.shutdown()
    assert scheduler.closed
    assert scheduler.poll(settings) == 0


def test_same_document_ingest_and_reindex_are_not_claimed_together(scheduled_jobs):
    factory, _, kb_id, _, _ = scheduled_jobs
    with factory() as db:
        claimed = claim_job(db, "first", kinds=("ingest",))
        second = IngestionJob(kb_id=kb_id, document_id=claimed.document_id, kind="reindex")
        db.add(second)
        db.commit()
        assert claim_job(db, "second", kinds=("reindex",)) is None
        claimed.lease_until = utcnow() - timedelta(seconds=1)
        db.commit()
        recovered = claim_job(db, "second", kinds=("ingest",))
        assert recovered.id == claimed.id and recovered.attempts == 2
        assert claim_job(db, "third", kinds=("reindex",)) is None


def test_wrapper_error_cannot_overwrite_transferred_or_cancelled_job(scheduled_jobs):
    factory, settings, _, _, _ = scheduled_jobs
    with factory() as db:
        job = claim_job(db, "old-owner", kinds=("ingest",))
        job_id = job.id

    def dispatch(*args):
        with factory() as db:
            job = db.get(IngestionJob, job_id)
            job.status = "cancelled"
            job.lease_owner = "new-owner"
            db.commit()
        raise RuntimeError("test failure after transfer")

    run_claimed_job(job_id, "ingest", "old-owner", settings, factory, dispatch)
    with factory() as db:
        job = db.get(IngestionJob, job_id)
        assert job.status == "cancelled" and job.lease_owner == "new-owner"
        assert job.error is None


def test_shutdown_keeps_heartbeat_for_claimed_work_until_it_finishes(scheduled_jobs, monkeypatch):
    from app.worker import scheduler as scheduler_module

    factory, settings, _, _, _ = scheduled_jobs
    settings.job_lease_seconds = 3
    release = threading.Event()
    heartbeat_seen = threading.Event()
    original = scheduler_module.heartbeat

    def observe_heartbeat(db, job_id, owner, lease_seconds):
        result = original(db, job_id, owner, lease_seconds)
        heartbeat_seen.set()
        return result

    monkeypatch.setattr(scheduler_module, "heartbeat", observe_heartbeat)

    def dispatch(job_id, kind, owner, config, session_factory):
        assert release.wait(4)
        with session_factory() as db:
            job = db.get(IngestionJob, job_id)
            job.status = "completed"
            job.lease_owner = job.lease_until = None
            db.commit()

    scheduler = WorkerScheduler("graceful-worker", settings, factory, dispatch)
    scheduler.poll(settings)
    with ThreadPoolExecutor(max_workers=1) as pool:
        finishing = pool.submit(scheduler.shutdown)
        try:
            assert heartbeat_seen.wait(2)
            assert not finishing.done()
            assert scheduler.poll(settings) == 0
        finally:
            release.set()
        finishing.result(timeout=3)
