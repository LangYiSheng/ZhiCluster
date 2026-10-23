from datetime import timedelta

from sqlalchemy import select

from app.db.models import Conversation, Document, IngestionJob, Message, User, utcnow


def uploaded_task(client):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    result = client.post(f"/api/knowledge-bases/{kb_id}/uploads", files=[("files", ("任务测试.md", b"# Task", "text/markdown"))]).json()
    return kb_id, result["items"][0]["document"]["id"], result["jobs"][0]["id"]


def test_task_names_filter_and_manual_retry_reset_progress(client, factory):
    kb_id, document_id, job_id = uploaded_task(client)
    with factory() as db:
        job = db.get(IngestionJob, job_id)
        job.status, job.stage, job.progress, job.error = "partial_ready", "completed", 100, "需要配置模型服务"
        document = db.get(Document, document_id)
        document.parse_status, document.index_status = "failed", "unconfigured"
        for index in range(201):
            db.add(IngestionJob(kb_id=kb_id, document_id=document_id, status="completed", progress=100, created_at=job.created_at + timedelta(seconds=index + 1)))
        db.commit()
    response = client.get(f"/api/ingestion/jobs?kb_id={kb_id}&document_id={document_id}&group=attention")
    assert response.status_code == 200
    assert [job["id"] for job in response.json()] == [job_id]
    assert response.json()[0]["document_name"] == "任务测试.md"
    assert response.json()[0]["document_available"] is True
    other_kb = client.post("/api/knowledge-bases", json={"name": "隔离库"}).json()["id"]
    assert client.get(f"/api/ingestion/jobs?kb_id={other_kb}&document_id={document_id}").status_code == 400
    assert client.post(f"/api/ingestion/jobs/{job_id}/retry").status_code == 200
    with factory() as db:
        job = db.get(IngestionJob, job_id)
        assert (job.status, job.stage, job.progress, job.error, job.attempts) == ("queued", "queued", 0, None, 0)
        document = db.get(Document, document_id)
        assert document.parse_status == document.index_status == "queued"


def test_retry_wait_can_be_cancelled_and_deleted_document_cannot_retry(client, factory):
    kb_id, document_id, job_id = uploaded_task(client)
    with factory() as db:
        job = db.get(IngestionJob, job_id)
        job.status, job.next_attempt_at = "retry_wait", utcnow() + timedelta(seconds=30)
        db.commit()
    assert client.post(f"/api/ingestion/jobs/{job_id}/cancel").status_code == 200
    assert client.delete(f"/api/documents/{document_id}").status_code == 200
    job = client.get(f"/api/ingestion/jobs?kb_id={kb_id}").json()[0]
    assert job["document_name"] is None and job["document_available"] is False
    assert client.post(f"/api/ingestion/jobs/{job_id}/retry").status_code == 404


def test_chat_retry_rejects_busy_and_past_turns_and_restores_last_failed_answer(client, factory):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    conversation = client.post("/api/conversations", json={"title": "任务重试", "scope": {"kb_ids": [kb_id]}}).json()
    message = client.post(f"/api/conversations/{conversation['id']}/messages", json={"content": "问题"}).json()
    with factory() as db:
        job = db.scalar(select(IngestionJob).where(IngestionJob.kind == "chat"))
        job.status, job.progress = "failed", 67
        db.get(Message, message["id"]).status = "failed"
        job_id = job.id
        db.commit()
    assert client.post(f"/api/ingestion/jobs/{job_id}/retry").status_code == 200
    with factory() as db:
        job = db.get(IngestionJob, job_id)
        assert job.status == "queued" and job.progress == 0
        failed = db.get(Message, message["id"])
        assert failed.status == "queued"
        job.status, failed.status = "failed", "failed"
        later = Message(conversation_id=conversation["id"], role="user", content="新的问题", created_at=failed.created_at + timedelta(seconds=1))
        db.add(later)
        active = Message(conversation_id=conversation["id"], role="assistant", status="queued", created_at=failed.created_at + timedelta(seconds=2))
        db.add(active)
        db.commit()
        active_id = active.id
    busy = client.post(f"/api/ingestion/jobs/{job_id}/retry")
    assert busy.status_code == 409
    assert "等待当前回复完成" in busy.text
    with factory() as db:
        db.get(Message, active_id).status = "completed"
        db.commit()
    response = client.post(f"/api/ingestion/jobs/{job_id}/retry")
    assert response.status_code == 409
    assert "已有新对话" in response.text
    with factory() as db:
        item = db.get(Conversation, conversation["id"])
        item.deleted_at = utcnow()
        db.commit()
    assert client.post(f"/api/ingestion/jobs/{job_id}/retry").status_code == 404


def test_shared_kb_editor_cannot_list_or_control_another_users_chat_jobs(client, factory):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    with factory() as db:
        other = User(email="other-chat@example.test", display_name="另一位用户")
        db.add(other)
        db.flush()
        conversation = Conversation(user_id=other.id, scope={"kb_ids": [kb_id]})
        db.add(conversation)
        db.flush()
        message = Message(conversation_id=conversation.id, role="assistant", status="queued")
        db.add(message)
        db.flush()
        job = IngestionJob(kb_id=kb_id, kind="chat", payload={"conversation_id": conversation.id, "message_id": message.id})
        db.add(job)
        db.commit()
        job_id = job.id
    assert all(job["id"] != job_id for job in client.get(f"/api/ingestion/jobs?kb_id={kb_id}").json())
    assert client.get(f"/api/ingestion/jobs/{job_id}").status_code == 404
    assert client.post(f"/api/ingestion/jobs/{job_id}/cancel").status_code == 404
    assert client.post(f"/api/ingestion/jobs/{job_id}/retry").status_code == 404
