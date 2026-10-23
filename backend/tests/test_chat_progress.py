from types import SimpleNamespace

from sqlalchemy import event as sa_event
from sqlalchemy import select

from app.ai.gateway import ModelGateway
from app.core.config import get_settings
from app.db.models import ConversationEvent, IngestionJob, Message
from app.services.chat import process_chat_job
from app.services.chat_context import build_context, conversation_context, retrieval_query
from app.worker.pipeline import process_ingestion_job


def test_independent_question_does_not_inherit_previous_topic():
    assert retrieval_query("论文需要几章？", "保研名额是多少？") == "论文需要几章？"
    assert "保研名额" in retrieval_query("那申请时间呢？", "保研名额是多少？")
    assert retrieval_query("完整的新问题" * 50, "旧主题").startswith("完整的新问题")


def test_context_is_bounded_and_ordinals_follow_selected_passages():
    text, selected = build_context([
        {"document_name": "第一份", "content": "甲" * 30},
        {"document_name": "太大的", "content": "乙" * 90},
        {"document_name": "第三份", "content": "丙" * 10},
    ], max_chars=80)
    assert [hit["document_name"] for hit in selected] == ["第一份", "第三份"]
    assert "[S1] 第一份" in text and "[S2] 第三份" in text and "[S3]" not in text
    history = [SimpleNamespace(role="assistant", content="旧答案[S8]" * 500, status="completed"),
               SimpleNamespace(role="user", content="继续说明", status="completed")]
    context = conversation_context(history, max_chars=3000)
    assert "[S8]" not in str(context) and sum(len(item["content"]) for item in context) <= 3000


def test_real_stage_replay_sources_before_output_and_batched_token_offsets(client, factory, monkeypatch):
    import app.services.chat as chat

    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    uploaded = client.post(f"/api/knowledge-bases/{kb_id}/uploads", files=[
        ("files", ("检索证据.txt", "中文检索资料中的真实内容。".encode()))]).json()
    process_ingestion_job(uploaded["jobs"][0]["id"], factory, get_settings())
    conversation_id = client.post("/api/conversations", json={"scope": {"kb_ids": [kb_id]}}).json()["id"]
    message_id = client.post(f"/api/conversations/{conversation_id}/messages", json={"content": "中文检索"}).json()["id"]
    with factory() as db:
        job_id = db.scalar(select(IngestionJob.id).where(IngestionJob.kind == "chat"))
    observations = []

    def stream(*_):
        with factory() as db:
            message = db.get(Message, message_id)
            observations.append(message.retrieval["execution"][-1]["stage"])
        snapshot = client.get(f"/api/conversations/{conversation_id}/messages").json()[-1]
        assert snapshot["citations"][0]["ordinal"] == 1
        yield "📚"
        yield from ["证"] * 1000
        yield "[S1][S999]"

    monkeypatch.setattr(ModelGateway, "llm_configured", property(lambda _: True))
    monkeypatch.setattr(ModelGateway, "chat", lambda *_args, **_kwargs: '{"ranked_ids":["C1"]}')
    monkeypatch.setattr(ModelGateway, "stream_chat", stream)
    original_emit = chat.emit_chat

    def record_locks(state):
        statement = state.statement
        if getattr(statement, "_for_update_arg", None) is not None:
            if any(description.get("entity") is IngestionJob for description in getattr(statement, "column_descriptions", [])):
                state.session.info["chat_job_locked"] = True

    def clear_locks(session, transaction):
        if transaction.parent is None:
            session.info["chat_job_locked"] = False

    def assert_candidate_lock_order(db, conversation_id, event_type, data):
        if event_type == "citation" and data.get("candidate"):
            # API cancellation takes job -> conversation. Candidate publication
            # must acquire its job lock in this transaction before emit_chat
            # acquires the conversation lock, including after context commit.
            assert db.info.get("chat_job_locked"), "candidate event reversed cancellation lock order"
        return original_emit(db, conversation_id, event_type, data)

    sa_event.listen(factory.class_, "do_orm_execute", record_locks)
    sa_event.listen(factory.class_, "after_transaction_end", clear_locks)
    monkeypatch.setattr(chat, "emit_chat", assert_candidate_lock_order)
    try:
        process_chat_job(job_id, factory, get_settings())
    finally:
        sa_event.remove(factory.class_, "do_orm_execute", record_locks)
        sa_event.remove(factory.class_, "after_transaction_end", clear_locks)
    with factory() as db:
        events = list(db.scalars(select(ConversationEvent).where(ConversationEvent.conversation_id == conversation_id).order_by(ConversationEvent.sequence)))
        tokens = [event for event in events if event.type == "token"]
        assert 1 < len(tokens) < 30  # More than 1,000 provider chunks, bounded transactions.
        output = ""
        for event in tokens:
            assert event.data["offset"] == len(output.encode("utf-16-le")) // 2
            output += event.data["token"]
        assert output == "📚" + "证" * 1000 + "[S1][S999]"
        assert next(index for index, event in enumerate(events) if event.type == "citation") < next(index for index, event in enumerate(events) if event.type == "token")
        message = db.get(Message, message_id)
        assert message.retrieval["stream_sequence"] == events[-1].sequence
        assert all(step["status"] == "completed" for step in message.retrieval["execution"])
        assert {step["stage"] for step in message.retrieval["execution"]} >= {"scope", "keyword", "ranking", "context", "generation"}
        assert message.retrieval["reranking"]["status"] == "skipped"
    assert observations == ["generation"]
    answer = client.get(f"/api/conversations/{conversation_id}/messages").json()[-1]
    assert "[引用无效]" in answer["content"] and [citation["ordinal"] for citation in answer["citations"]] == [1]
    replay = client.get(f"/api/conversations/{conversation_id}/events").text
    assert 'event: progress' in replay and '"stage": "generation"' in replay and 'event: completed' in replay


def test_deleting_conversation_cancels_its_current_job_without_waiting_for_lease_expiry(client, factory, monkeypatch):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    uploaded = client.post(f"/api/knowledge-bases/{kb_id}/uploads", files=[
        ("files", ("删除期间.txt", "中文检索资料。".encode()))]).json()
    process_ingestion_job(uploaded["jobs"][0]["id"], factory, get_settings())
    conversation_id = client.post("/api/conversations", json={"scope": {"kb_ids": [kb_id]}}).json()["id"]
    message_id = client.post(f"/api/conversations/{conversation_id}/messages", json={"content": "中文检索"}).json()["id"]
    with factory() as db:
        job = db.scalar(select(IngestionJob).where(IngestionJob.kind == "chat"))
        job.status, job.lease_owner = "running", "current-worker"
        job_id = job.id
        db.commit()

    def removed_during_stream(*_):
        assert client.delete(f"/api/conversations/{conversation_id}").status_code == 200
        yield "已删除会话不应继续生成"

    monkeypatch.setattr(ModelGateway, "llm_configured", property(lambda _: True))
    monkeypatch.setattr(ModelGateway, "chat", lambda *_args, **_kwargs: '{"ranked_ids":["C1"]}')
    monkeypatch.setattr(ModelGateway, "stream_chat", removed_during_stream)
    process_chat_job(job_id, factory, get_settings(), owner="current-worker")
    with factory() as db:
        job = db.get(IngestionJob, job_id)
        assert job.status == "cancelled" and job.lease_owner is None and job.lease_until is None
        message = db.get(Message, message_id)
        assert message.status == "failed" and message.content == ""
        assert "已取消" in message.error
