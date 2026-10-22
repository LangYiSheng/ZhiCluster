"""Queue integration; all planning runs in the independent worker process."""

from app.agent.graph import process_agent_run
from app.db.models import IngestionJob

__all__ = ["process_agent_run", "process_agent_job"]


def process_agent_job(job_id, session_factory, settings=None, owner=None):
    with session_factory() as db:
        job = db.get(IngestionJob, job_id)
        if not job or job.kind != "agent" or job.status != "running" or (owner and job.lease_owner != owner):
            return
        process_agent_run(db, job.payload["run_id"], job_id=job.id, owner=owner or job.lease_owner)
