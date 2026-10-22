"""Regression checks for issues found during the final cross-module review."""

import pytest
from sqlalchemy import func, select

from app.ai.gateway import ModelGateway
from app.api.events import event_stream
from app.api.workflows import checked_job
from app.core.config import Settings, get_settings
from app.db.models import (
    ChunkEmbedding,
    ConversationEvent,
    Document,
    DocumentChunk,
    EmbeddingProfile,
    IngestionJob,
    JobEvent,
    KnowledgeBase,
    Message,
    MessageCitation,
)
from app.services.chat import process_chat_job
from app.services.library import update_document
from app.services.permissions import get_actor
from app.worker.pipeline import process_ingestion_job


def source_and_chat(client, factory):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    uploaded = client.post(f"/api/knowledge-bases/{kb_id}/uploads", files=[
        ("files", ("证据.txt", "中文检索来自真实文档。".encode()))]).json()
    document_id = uploaded["items"][0]["document"]["id"]
    process_ingestion_job(uploaded["jobs"][0]["id"], factory, get_settings())
    conversation = client.post("/api/conversations", json={"scope": {"kb_ids": [kb_id]}}).json()
    message = client.post(f"/api/conversations/{conversation['id']}/messages", json={"content": "中文检索"}).json()
    with factory() as db:
        job_id = db.scalar(select(IngestionJob.id).where(IngestionJob.kind == "chat"))
        chunk_id = db.scalar(select(DocumentChunk.id).where(DocumentChunk.document_id == document_id))
    return kb_id, document_id, conversation["id"], message["id"], job_id, chunk_id


def test_empty_conversation_scope_and_foreign_filter_are_rejected(client):
    base = client.get("/api/knowledge-bases").json()[0]["id"]
    other = client.post("/api/knowledge-bases", json={"name": "另一知识库"}).json()["id"]
    folder = client.post(f"/api/knowledge-bases/{other}/folders", json={"name": "别库目录"}).json()
    invalid = client.post("/api/conversations", json={"scope": {"kb_ids": [base], "folder_ids": [folder["id"]]}})
    assert invalid.status_code == 400 and invalid.json()["code"] == "invalid_folder"
    client.delete(f"/api/knowledge-bases/{base}")
    client.delete(f"/api/knowledge-bases/{other}")
    empty = client.post("/api/conversations", json={"scope": {}})
    assert empty.status_code == 400 and empty.json()["code"] == "empty_scope"


@pytest.mark.asyncio
async def test_active_sse_rechecks_permission_after_kb_deleted(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        kb_id = kb.id
        job = IngestionJob(kb_id=kb.id, kind="chat", status="running")
        db.add(job)
        db.flush()
        job_id = job.id
        db.add(JobEvent(job_id=job.id, sequence=1, type="token", data={"token": "first"}))
        db.commit()
    stream = event_stream(JobEvent, JobEvent.job_id, job_id, session_factory=factory,
                          authorize=lambda db: checked_job(db, job_id))
    iterator = stream.body_iterator
    first = await anext(iterator)
    assert "first" in first
    with factory() as db:
        from app.db.models import utcnow

        db.get(KnowledgeBase, kb_id).deleted_at = utcnow()
        db.add(JobEvent(job_id=job_id, sequence=2, type="token", data={"token": "PRIVATE_AFTER_REVOCATION"}))
        db.commit()
    stopped = await anext(iterator)
    assert "event: error" in stopped and "PRIVATE_AFTER_REVOCATION" not in stopped
    with pytest.raises(StopAsyncIteration):
        await anext(iterator)


def test_sse_replay_redacts_deleted_source_snippet(client, factory):
    _, document_id, conversation_id, message_id, _, _ = source_and_chat(client, factory)
    with factory() as db:
        db.get(Message, message_id).status = "completed"
        sequence = (db.scalar(select(func.max(ConversationEvent.sequence)).where(ConversationEvent.conversation_id == conversation_id)) or 0) + 1
        db.add(ConversationEvent(conversation_id=conversation_id, sequence=sequence, type="citation",
            data={"document_id": document_id, "snippet": "PRIVATE_DELETED_SNIPPET"}))
        db.commit()
    client.delete(f"/api/documents/{document_id}")
    replay = client.get(f"/api/conversations/{conversation_id}/events")
    assert replay.status_code == 200
    assert "PRIVATE_DELETED_SNIPPET" not in replay.text
    assert "来源已删除或不可访问" in replay.text


def test_chat_retry_replaces_old_citations_and_clears_error(client, factory, monkeypatch):
    _, document_id, _, message_id, job_id, chunk_id = source_and_chat(client, factory)
    with factory() as db:
        message = db.get(Message, message_id)
        message.content, message.error, message.status = "old answer", "old error", "failed"
        job = db.get(IngestionJob, job_id)
        job.status, job.lease_owner = "running", "retry-worker"
        db.add(MessageCitation(message_id=message_id, document_id=document_id, chunk_id=chunk_id,
                              ordinal=1, anchors={}, snippet="old snippet"))
        db.commit()
    monkeypatch.setattr(ModelGateway, "llm_configured", property(lambda _: True))
    monkeypatch.setattr(ModelGateway, "stream_chat", lambda *_: iter(["新的回答[S1]"]))
    process_chat_job(job_id, factory, get_settings(), owner="retry-worker")
    with factory() as db:
        message = db.get(Message, message_id)
        assert message.content == "新的回答[S1]" and message.error is None
        assert db.scalar(select(func.count()).select_from(MessageCitation).where(MessageCitation.message_id == message_id)) == 1


def test_stale_chat_worker_cannot_reset_new_owner_output(client, factory):
    _, _, _, message_id, job_id, _ = source_and_chat(client, factory)
    with factory() as db:
        message = db.get(Message, message_id)
        message.content, message.status = "新 worker 已写入的回答", "processing"
        job = db.get(IngestionJob, job_id)
        job.status, job.lease_owner = "running", "new-worker"
        db.commit()
    process_chat_job(job_id, factory, get_settings(), owner="stale-worker")
    with factory() as db:
        assert db.get(Message, message_id).content == "新 worker 已写入的回答"
        assert db.get(IngestionJob, job_id).lease_owner == "new-worker"


def test_chat_cancel_releases_conversation_for_next_question(client, factory):
    _, _, conversation_id, message_id, job_id, _ = source_and_chat(client, factory)
    assert client.post(f"/api/ingestion/jobs/{job_id}/cancel").status_code == 200
    with factory() as db:
        assert db.get(Message, message_id).status == "failed"
    assert client.post(f"/api/conversations/{conversation_id}/messages", json={"content": "重新提问"}).status_code == 202


def test_document_write_refreshes_cached_entity_version(client, factory):
    _, document_id, _, _, _, _ = source_and_chat(client, factory)
    with factory() as first, factory() as second:
        cached = first.get(Document, document_id)
        assert cached.version == 1
        update_document(second, get_actor(second), document_id, {"display_name": "另一个请求已改名.txt"})
        second.commit()
        update_document(first, get_actor(first), document_id, {"tag_ids": []})
        first.commit()
        assert cached.version == 3
        assert cached.display_name == "另一个请求已改名.txt"


def test_model_status_detects_missing_vectors_for_existing_profile(client, factory, monkeypatch):
    import app.api.workflows as api

    _, document_id, _, _, _, chunk_id = source_and_chat(client, factory)
    settings = Settings(embedding_base_url="https://embedding.test/v1", embedding_api_key="test-key",
                        embedding_model="test-model", embedding_dimension=2)
    monkeypatch.setattr(api, "get_settings", lambda: settings)
    with factory() as db:
        profile = EmbeddingProfile(fingerprint=ModelGateway(settings).profile_fingerprint,
                                   model_name=settings.embedding_model, dimension=2)
        db.add(profile)
        db.get(Document, document_id).index_status = "ready"
        db.commit()
        profile_id = profile.id
    assert client.get("/api/settings/model-status").json()["embedding"]["needs_rebuild"] is True
    with factory() as db:
        doc = db.get(Document, document_id)
        db.add(ChunkEmbedding(kb_id=doc.kb_id, chunk_id=chunk_id, profile_id=profile_id, embedding=[1.0, 0.0]))
        db.commit()
    assert client.get("/api/settings/model-status").json()["embedding"]["needs_rebuild"] is False
