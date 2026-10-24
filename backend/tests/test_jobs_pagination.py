"""Task history remains reachable when it exceeds the legacy list cap."""

from datetime import UTC, datetime

from sqlalchemy import select

from app.db.models import Conversation, Document, IngestionJob, KnowledgeBase, User, utcnow
from app.services.permissions import DEMO_USER_ID


def seed_jobs(factory, count=260, status="partial_ready"):
    with factory() as db:
        base = db.scalar(select(KnowledgeBase))
        doc = Document(kb_id=base.id, owner_id=DEMO_USER_ID, display_name="历史任务.txt", original_filename="历史任务.txt",
            mime_type="text/plain", ext="txt", sha256="0", size_bytes=1, storage_key="job-pages/history/original")
        db.add(doc)
        db.flush()
        frozen = datetime(2026, 10, 24, tzinfo=UTC)
        jobs = [IngestionJob(id=f"{n:036d}", kb_id=base.id, document_id=doc.id, kind="ingest", status=status,
            error="需要配置模型" if status == "partial_ready" else None, created_at=frozen) for n in range(count)]
        db.add_all(jobs)
        db.commit()
        return base.id, doc.id, [job.id for job in jobs]


def test_job_page_reaches_all_history_with_stable_tie_order_and_real_counts(client, factory):
    kb_id, _, ids = seed_jobs(factory)
    legacy = client.get(f"/api/ingestion/jobs?kb_id={kb_id}")
    assert legacy.status_code == 200 and len(legacy.json()) == 200
    found = []
    for page in range(1, 7):
        result = client.get(f"/api/ingestion/jobs/page?kb_id={kb_id}&group=attention&page={page}&page_size=50")
        assert result.status_code == 200, result.text
        data = result.json()
        assert data["total"] == 260 and data["page"] == page and data["page_size"] == 50
        assert data["counts"] == {"all": 260, "attention": 260, "active": 0, "completed": 0}
        found.extend(item["id"] for item in data["items"])
    assert found == list(reversed(ids))


def test_page_counts_share_visibility_and_document_scope_with_list(client, factory):
    kb_id, doc_id, _ = seed_jobs(factory, count=1)
    with factory() as db:
        other = User(email="hidden-jobs@example.test", display_name="其他用户")
        db.add(other)
        db.flush()
        conversation = Conversation(user_id=other.id, scope={"kb_ids": [kb_id]})
        db.add(conversation)
        db.flush()
        db.add_all([
            IngestionJob(kb_id=kb_id, document_id=doc_id, status="completed"),
            IngestionJob(kb_id=kb_id, document_id=doc_id, status="queued"),
            IngestionJob(kb_id=kb_id, document_id=doc_id, status="retry_wait", error="网络失败"),
            IngestionJob(kb_id=kb_id, document_id=doc_id, status="retry_wait", error=None),
            IngestionJob(kb_id=kb_id, kind="chat", status="failed", payload={"conversation_id": conversation.id}),
        ])
        db.commit()
    result = client.get(f"/api/ingestion/jobs/page?kb_id={kb_id}&document_id={doc_id}&group=active&page_size=2").json()
    assert result["total"] == 3 and len(result["items"]) == 2
    assert result["counts"] == {"all": 5, "attention": 2, "active": 3, "completed": 1}
    # The shared KB's foreign chat job must not leak through aggregate counts.
    result = client.get(f"/api/ingestion/jobs/page?kb_id={kb_id}&page_size=1").json()
    assert result["counts"]["all"] == 5 and result["counts"]["attention"] == 2
    assert client.get(f"/api/ingestion/jobs/page?kb_id={kb_id}&page=0").status_code == 422
    assert client.get(f"/api/ingestion/jobs/page?kb_id={kb_id}&page_size=201").status_code == 422


def test_current_document_jobs_cover_old_documents_and_prioritize_running(client, factory):
    kb_id, doc_id, ids = seed_jobs(factory)
    latest = client.get(f"/api/ingestion/jobs?kb_id={kb_id}&document_ids={doc_id}&view=current").json()
    assert [job["id"] for job in latest] == [ids[-1]]
    with factory() as db:
        # A running task should remain visible even when newer history exists.
        old = db.get(IngestionJob, ids[0])
        old.status = "running"
        second = Document(kb_id=kb_id, owner_id=DEMO_USER_ID, display_name="更早资料.txt", original_filename="更早资料.txt",
            mime_type="text/plain", ext="txt", sha256="1", size_bytes=1, storage_key="job-pages/second/original")
        db.add(second)
        db.flush()
        db.add(IngestionJob(kb_id=kb_id, document_id=second.id, status="failed", created_at=datetime(2020, 1, 1, tzinfo=UTC)))
        db.commit()
        second_id = second.id
    result = client.get(f"/api/ingestion/jobs?kb_id={kb_id}&document_ids={doc_id},{second_id}&view=current")
    assert result.status_code == 200, result.text
    jobs = {job["document_id"]: job for job in result.json()}
    assert set(jobs) == {doc_id, second_id}
    assert jobs[doc_id]["id"] == ids[0] and jobs[doc_id]["status"] == "running"
    assert jobs[second_id]["document_name"] == "更早资料.txt"
    assert client.get(f"/api/ingestion/jobs?kb_id={kb_id}&view=current").status_code == 400
    ids_query = ",".join(str(number) for number in range(201))
    assert client.get(f"/api/ingestion/jobs?kb_id={kb_id}&document_ids={ids_query}&view=current").status_code == 400


def test_current_batch_cannot_leak_foreign_kb_or_deleted_documents(client, factory):
    kb_id, doc_id, _ = seed_jobs(factory, count=1)
    with factory() as db:
        owner = User(email="private-batch@example.test", display_name="私有用户")
        db.add(owner)
        db.flush()
        private = KnowledgeBase(owner_id=owner.id, name="私有知识库")
        db.add(private)
        db.flush()
        doc = Document(kb_id=private.id, owner_id=owner.id, display_name="不可见.txt", original_filename="不可见.txt",
            mime_type="text/plain", ext="txt", sha256="2", size_bytes=1, storage_key="job-pages/private/original")
        db.add(doc)
        db.flush()
        db.add(IngestionJob(kb_id=private.id, document_id=doc.id, status="failed"))
        db.get(Document, doc_id).deleted_at = utcnow()
        db.commit()
        private_id, private_doc_id = private.id, doc.id
    result = client.get(f"/api/ingestion/jobs?document_ids={doc_id},{private_doc_id}&view=current")
    assert result.status_code == 200 and result.json() == []
    assert client.get(f"/api/ingestion/jobs/page?kb_id={private_id}").status_code == 403
    # Normal history still keeps deleted-document jobs, as the legacy list did.
    result = client.get(f"/api/ingestion/jobs/page?kb_id={kb_id}").json()
    assert result["total"] == 1 and result["items"][0]["document_available"] is False
