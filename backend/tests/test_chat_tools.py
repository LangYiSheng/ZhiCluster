"""Actual tool/JSON planning contracts with deterministic, isolated read-only data."""

import json

import httpx
import pytest
from sqlalchemy import delete, select

from app.ai.gateway import AIUnavailable, ModelGateway, ProviderError
from app.core.config import Settings
from app.core.errors import AppError
from app.db.models import (
    Conversation,
    ConversationEvent,
    Document,
    DocumentChunk,
    DocumentSection,
    DocumentTag,
    Folder,
    IngestionJob,
    KnowledgeBase,
    KnowledgeBaseMember,
    Message,
    MessageCitation,
    Tag,
    new_id,
    utcnow,
)
from app.retrieval.chat_tools import SEARCH_TOOL, SearchPlanner, current_hits, model_retrieval
from app.retrieval.search import search_knowledge
from app.services.chat import process_chat_job
from app.services.chat_context import build_context
from app.services.permissions import get_actor


def settings(**overrides):
    return Settings(llm_base_url="https://controlled.invalid/v1", llm_api_key="fake-key", llm_model="controlled",
        embedding_base_url="", embedding_api_key="", embedding_model="", **overrides)


def source(db, kb_id, content, *, folder_id=None, ext="txt"):
    doc = Document(kb_id=kb_id, owner_id=get_actor(db).id, display_name=f"实际资料-{new_id()[:4]}.{ext}",
        original_filename=f"test.{ext}", storage_key=new_id(), sha256=new_id(), mime_type="text/plain",
        size_bytes=len(content), ext=ext, folder_id=folder_id, parse_status="ready", index_status="ready")
    db.add(doc)
    db.flush()
    section = DocumentSection(kb_id=kb_id, document_id=doc.id, plain_text=content, anchors={"paragraph": 1})
    db.add(section)
    db.flush()
    chunk = DocumentChunk(kb_id=kb_id, document_id=doc.id, section_id=section.id, chunk_index=0,
        content=content, token_count=len(content), anchors=section.anchors)
    db.add(chunk)
    db.flush()
    return doc, chunk


def start_chat(client, factory, *, retrieval_mode="model", scope=None):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    with factory() as db:
        doc, chunk = source(db, kb_id, "年度申请政策采用公开综合考核。计算学部名额为28人。")
        db.commit()
        doc_id, chunk_id = doc.id, chunk.id
    conversation = client.post("/api/conversations", json={"scope": scope or {"kb_ids": [kb_id]}}).json()["id"]
    message = client.post(f"/api/conversations/{conversation}/messages", json={
        "content": "研究中心申请政策和计算学部今年名额？", "retrieval_mode": retrieval_mode}).json()["id"]
    with factory() as db:
        job = db.scalar(select(IngestionJob).where(IngestionJob.kind == "chat"))
        job.status, job.lease_owner = "running", "current"
        db.commit()
        job_id = job.id
    return kb_id, doc_id, chunk_id, conversation, message, job_id


@pytest.mark.parametrize("native", [False, True])
def test_opt_in_chat_executes_real_queries_then_keeps_stream_and_citation_whitelist(client, factory, monkeypatch, native):
    _, _, _, conversation, message_id, job_id = start_chat(client, factory)
    planned, streamed = [], []

    def plan(self, messages, **options):
        planned.append((messages.copy(), options))
        assert self.settings.llm_timeout_seconds == 12 and self.settings.llm_max_retries == 0
        if len(planned) == 1:
            queries = ["年度申请政策", "计算学部名额"]
        else:
            assert any(item["role"] == ("tool" if native else "user") and "source_count" in item.get("content", "") for item in messages)
            queries = []
        if native:
            return {"role": "assistant", "content": None, "tool_calls": [{"id": f"read-{index}", "type": "function",
                "function": {"name": "search_knowledge", "arguments": json.dumps({"query": query})}}
                for index, query in enumerate(queries)]}
        assert options["json_mode"] is True and "tools" not in options
        return json.dumps({"searches": [{"query": query} for query in queries]})

    def stream(_self, messages, **_options):
        streamed.append(messages)
        yield "公开考核，名额28人。[S1][S900]"

    monkeypatch.setattr(ModelGateway, "chat_tools" if native else "chat", plan)
    monkeypatch.setattr(ModelGateway, "stream_chat", stream)
    process_chat_job(job_id, factory, settings(llm_supports_tools=native), owner="current")
    assert len(planned) == 2 and len(streamed) == 1
    assert "年度申请政策" in str(streamed[0]) and "名额" in str(streamed[0])
    with factory() as db:
        message = db.get(Message, message_id)
        assert message.status == "completed" and "[引用无效]" in message.content
        assert message.retrieval["model_retrieval"] == {"rounds": 2, "searches": 2, "fallback": False}
        assert message.retrieval["retrieval_strategy"] == ("native_tools" if native else "json_planning")
        assert len(list(db.scalars(select(MessageCitation).where(MessageCitation.message_id == message_id)))) == 1
        events = list(db.scalars(select(ConversationEvent).where(ConversationEvent.conversation_id == conversation)))
        steps = message.retrieval["execution"]
        searches = [step for step in steps if step["stage"] == "search"]
        assert [step["query"] for step in searches] == ["年度申请政策", "计算学部名额"]
        assert all((step.get("tool_name") == "search_knowledge") is native for step in searches)
        assert any(event.type == "token" for event in events)


def test_message_request_defaults_direct_and_rejects_unknown_mode(client, factory, monkeypatch):
    _, _, _, conversation, message_id, job_id = start_chat(client, factory, retrieval_mode="direct")
    def forbidden(*_args, **_kwargs):
        raise AssertionError("ordinary chat must not invoke a planner")

    monkeypatch.setattr(ModelGateway, "chat", forbidden)
    monkeypatch.setattr(ModelGateway, "chat_tools", forbidden)
    monkeypatch.setattr(ModelGateway, "stream_chat", lambda *_args, **_kwargs: iter(["直接回答[S1]"]))
    process_chat_job(job_id, factory, settings(), owner="current")
    with factory() as db:
        assert db.get(Message, message_id).status == "completed"
    queued = client.post(f"/api/conversations/{conversation}/messages", json={"content": "新的问题"})
    assert queued.status_code == 202
    with factory() as db:
        jobs = list(db.scalars(select(IngestionJob).where(IngestionJob.kind == "chat")))
        assert all(job.payload["retrieval_mode"] == "direct" for job in jobs)
    assert client.post(f"/api/conversations/{conversation}/messages", json={"content": "问题", "retrieval_mode": "arbitrary-agent"}).status_code == 422


@pytest.mark.parametrize("response", [
    '{"searches":[{"query":"   "}]}',
    '{"searches":[' + ','.join('{"query":"测试"}' for _ in range(4)) + ']}',
    '{"searches":[]}',
    'invalid JSON',
])
def test_bad_json_plans_fall_back_once_without_model_owned_filters(client, factory, monkeypatch, response):
    _, _, _, _, message_id, job_id = start_chat(client, factory)
    calls = []
    monkeypatch.setattr(ModelGateway, "chat", lambda *_args, **_kwargs: response)
    monkeypatch.setattr(ModelGateway, "stream_chat", lambda *_args, **_kwargs: iter(["回答[S1]"]))
    import app.services.chat as chat
    actual_search = chat.search_knowledge

    def search(db, actor, request, *args, **kwargs):
        calls.append(request)
        return actual_search(db, actor, request, *args, **kwargs)

    monkeypatch.setattr(chat, "search_knowledge", search)
    process_chat_job(job_id, factory, settings(), owner="current")
    assert len(calls) == 1 and calls[0]["query"] == "研究中心申请政策和计算学部今年名额？"
    with factory() as db:
        message = db.get(Message, message_id)
        assert message.status == "completed" and message.retrieval["model_retrieval"]["fallback"]
        assert "retrieval_fallback" in {step["stage"] for step in message.retrieval["execution"]}


def test_planner_timeout_falls_back_and_does_not_change_saved_capability(client, factory, monkeypatch):
    _, _, _, _, message_id, job_id = start_chat(client, factory)
    original = settings(llm_supports_tools=False, llm_timeout_seconds=120, llm_max_retries=2)
    count = []
    def unavailable(*_args, **_kwargs):
        count.append(1)
        raise ProviderError("等待聊天模型响应超时", retryable=True, code="read_timeout")
    monkeypatch.setattr(ModelGateway, "chat", unavailable)
    monkeypatch.setattr(ModelGateway, "stream_chat", lambda *_args, **_kwargs: iter(["可用资料[S1]"]))
    process_chat_job(job_id, factory, original, owner="current")
    assert count == [1] and original.llm_supports_tools is False and original.llm_timeout_seconds == 120
    with factory() as db:
        assert db.get(Message, message_id).status == "completed"


def test_all_scope_filters_remain_fixed_and_rechecks_sources_after_planning(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        folder = Folder(kb_id=kb.id, name="范围内目录")
        elsewhere = Folder(kb_id=kb.id, name="范围外目录")
        tag = Tag(kb_id=kb.id, name="必选标签", normalized_name="必选标签")
        db.add_all([folder, elsewhere, tag])
        db.flush()
        permitted, _ = source(db, kb.id, "名额28人", folder_id=folder.id)
        no_tag, _ = source(db, kb.id, "名额SECRET", folder_id=folder.id)
        wrong_folder, _ = source(db, kb.id, "名额SECRET", folder_id=elsewhere.id)
        wrong_ext, _ = source(db, kb.id, "名额SECRET", folder_id=folder.id, ext="md")
        for doc in (permitted, wrong_folder, wrong_ext):
            db.add(DocumentTag(kb_id=kb.id, document_id=doc.id, tag_id=tag.id))
        db.commit()
        scope = {"kb_ids": [kb.id], "folder_ids": [folder.id], "include_descendants": False,
            "tag_ids": [tag.id], "tag_match": "all", "document_ids": [permitted.id, no_tag.id, wrong_folder.id, wrong_ext.id],
            "exts": ["txt"], "date_from": "2000-01-01", "date_to": "2100-01-01"}
        requests = []

        class Planner:
            native, turns = False, 0
            def next_turn(self, remaining):
                self.turns += 1
                return [{"query": "名额"}] if self.turns == 1 else []
            def feedback(self, value):
                assert "SECRET" not in str(value)

        def search(request, callback):
            requests.append(request)
            for key in scope:
                assert request[key] == scope[key]
            return search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, settings(), on_progress=callback)

        result = model_retrieval(db, get_actor(db), scope, "名额", settings(), search=search,
            progress=lambda *_args, **_kwargs: None, check_active=lambda: None, planner=Planner())
        assert [hit["document_id"] for hit in result["items"]] == [permitted.id]
        assert len(requests) == 1 and scope["document_ids"][0] == permitted.id


def test_search_budget_deduplicates_and_context_includes_separator_budget(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        source(db, kb.id, "政策" * 4000)
        db.commit()
        calls = []

        class Planner:
            native, turns = False, 0
            def next_turn(self, remaining):
                self.turns += 1
                assert remaining == (3 if self.turns == 1 else 1)
                return [{"query": "政策"}, {"query": " 政策 "}, {"query": "申请政策"}] if self.turns == 1 else [{"query": "名额政策"}]
            def feedback(self, value):
                assert len(str(value)) < 6500

        def search(request, callback):
            calls.append(request["query"])
            return search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, settings(), on_progress=callback)

        result = model_retrieval(db, get_actor(db), {"kb_ids": [kb.id]}, "初始问题", settings(),
            search=search, progress=lambda *_args, **_kwargs: None, check_active=lambda: None, planner=Planner())
        assert calls == ["政策", "申请政策", "名额政策"]
        assert result["model_retrieval"]["rounds"] == 2 and len(result["items"]) == 1
        contexts, hits = build_context([{"document_name": str(index), "content": "文" * 6000} for index in range(20)])
        assert len(contexts) <= 24000 and len(hits) == 3


@pytest.mark.parametrize("failed_search", [1, 3])
def test_failed_searches_consume_budget_and_are_not_repeated_by_fallback(factory, failed_search):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        first, _ = source(db, kb.id, "policy evidence")
        second, _ = source(db, kb.id, "quota evidence")
        db.commit()
        calls, steps = [], []

        class Planner:
            native = False
            def next_turn(self, _remaining):
                return [{"query": query} for query in (
                    [" ORIGINAL   question "] if failed_search == 1 else ["policy", "quota", "third"])]
            def feedback(self, _value):
                raise AssertionError("failed search ends planning")

        def search(request, callback):
            calls.append(request["query"])
            if len(calls) == failed_search:
                raise ProviderError("secret URL must not enter public state", retryable=True)
            return search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, settings(), on_progress=callback)

        result = model_retrieval(db, get_actor(db), {"kb_ids": [kb.id]}, "original question", settings(),
            search=search, progress=lambda *args, **data: steps.append((args, data)), check_active=lambda: None, planner=Planner())
        assert len(calls) == failed_search
        assert result["model_retrieval"]["searches"] == failed_search
        assert result["model_retrieval"]["fallback"]
        assert "secret" not in str(result) + str(steps)
        assert {hit["document_id"] for hit in result["items"]} == ({first.id, second.id} if failed_search == 3 else set())


@pytest.mark.parametrize("failure", [ProviderError, AIUnavailable, RuntimeError])
@pytest.mark.parametrize("handoff", [False, True])
def test_deleted_conversation_during_model_error_is_cancelled_without_error_event(client, factory, monkeypatch, failure, handoff):
    _, _, _, conversation_id, message_id, job_id = start_chat(client, factory, retrieval_mode="direct")

    def stream(*_args, **_kwargs):
        with factory() as writer:
            writer.get(Conversation, conversation_id).deleted_at = utcnow()
            if handoff:
                writer.get(IngestionJob, job_id).lease_owner = "new-owner"
                writer.get(Message, message_id).content = "新worker已提交内容"
            writer.commit()
        raise failure("provider error after deletion")
        yield  # Model can fail before producing any stream fragment.

    monkeypatch.setattr(ModelGateway, "stream_chat", stream)
    process_chat_job(job_id, factory, settings(), owner="current")
    with factory() as db:
        job, message = db.get(IngestionJob, job_id), db.get(Message, message_id)
        if handoff:
            assert job.status == "running" and job.lease_owner == "new-owner"
            assert message.content == "新worker已提交内容" and message.error is None
        else:
            assert job.status == "cancelled" and job.lease_owner is job.lease_until is None
            assert message.status == "failed" and message.content == "" and "已取消" in message.error
        assert not list(db.scalars(select(ConversationEvent).where(
            ConversationEvent.conversation_id == conversation_id, ConversationEvent.type == "error")))


@pytest.mark.parametrize("change", ["cancel", "handoff", "permission", "delete_source"])
def test_no_tool_executes_after_cancel_handoff_or_permission_loss(client, factory, monkeypatch, change):
    kb_id, doc_id, _, _, message_id, job_id = start_chat(client, factory)
    searched = []

    def plan(*_args, **_kwargs):
        with factory() as writer:
            job = writer.get(IngestionJob, job_id)
            if change == "cancel":
                job.status = "cancelled"
                writer.get(Message, message_id).content = "用户已取消"
            elif change == "handoff":
                job.lease_owner = "new-owner"
                writer.get(Message, message_id).content = "新worker输出"
            elif change == "permission":
                writer.execute(delete(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == kb_id))
            else:
                writer.get(Document, doc_id).deleted_at = utcnow()
            writer.commit()
        return '{"searches":[{"query":"年度申请政策"}]}'

    monkeypatch.setattr(ModelGateway, "chat", plan)
    monkeypatch.setattr(ModelGateway, "stream_chat", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("no available source")))
    import app.services.chat as chat
    actual_search = chat.search_knowledge
    def search(*args, **kwargs):
        searched.append(1)
        return actual_search(*args, **kwargs)
    monkeypatch.setattr(chat, "search_knowledge", search)
    if change == "permission":
        with pytest.raises(AppError):
            process_chat_job(job_id, factory, settings(), owner="current")
    else:
        process_chat_job(job_id, factory, settings(), owner="current")
    assert len(searched) == (1 if change == "delete_source" else 0)
    with factory() as db:
        job, message = db.get(IngestionJob, job_id), db.get(Message, message_id)
        if change == "handoff":
            assert job.lease_owner == "new-owner" and message.content == "新worker输出"
        if change == "cancel":
            assert job.status == "cancelled" and message.content == "用户已取消"
        assert not list(db.scalars(select(MessageCitation).where(MessageCitation.message_id == message_id)))


def test_current_hit_revalidation_removes_deleted_moved_and_revoked_sources(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        selected, elsewhere = Folder(kb_id=kb.id, name="选中目录"), Folder(kb_id=kb.id, name="其他目录")
        db.add_all([selected, elsewhere])
        db.flush()
        doc, _ = source(db, kb.id, "政策", folder_id=selected.id)
        db.commit()
        actor = get_actor(db)
        results = search_knowledge(db, actor, {"kb_ids": [kb.id], "query": "政策", "mode": "keyword"}, settings())
        with factory() as writer:
            writer.get(Document, doc.id).folder_id = elsewhere.id
            writer.commit()
        assert current_hits(db, actor, {"kb_ids": [kb.id], "folder_ids": [selected.id]}, results["items"]) == []
        with factory() as writer:
            writer.get(Document, doc.id).deleted_at = utcnow()
            writer.commit()
        assert current_hits(db, actor, {"kb_ids": [kb.id]}, results["items"]) == []
        with factory() as writer:
            writer.execute(delete(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == kb.id))
            writer.commit()
        with pytest.raises(AppError):
            current_hits(db, actor, {"kb_ids": [kb.id]}, results["items"])


def test_source_deleted_during_stream_cannot_survive_as_valid_citation(client, factory, monkeypatch):
    _, doc_id, _, _, message_id, job_id = start_chat(client, factory, retrieval_mode="direct")

    def stream(*_args, **_kwargs):
        with factory() as writer:
            writer.get(Document, doc_id).deleted_at = utcnow()
            writer.commit()
        yield "引用已删除的来源[S1]"

    monkeypatch.setattr(ModelGateway, "stream_chat", stream)
    process_chat_job(job_id, factory, settings(), owner="current")
    with factory() as db:
        assert db.get(Message, message_id).content == "引用已删除的来源[引用无效]"
        assert not list(db.scalars(select(MessageCitation).where(MessageCitation.message_id == message_id)))


def test_native_transport_contract_and_false_capability_never_sends_tools():
    requests = []
    def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        assert payload["tools"] == [SEARCH_TOOL] and payload["tool_choice"] == "auto" and not payload.get("stream")
        return httpx.Response(200, json={"choices": [{"finish_reason": "tool_calls", "message": {"tool_calls": [
            {"id": "call-1", "type": "function", "function": {"name": "search_knowledge", "arguments": '{"query":"政策"}'}}]}}]})
    gateway = ModelGateway(settings(llm_supports_tools=True), transport=httpx.MockTransport(respond))
    assert gateway.chat_tools([{"role": "user", "content": "政策"}], tools=[SEARCH_TOOL])["tool_calls"][0]["id"] == "call-1"
    disabled = ModelGateway(settings(llm_supports_tools=False), transport=httpx.MockTransport(respond))
    with pytest.raises(AIUnavailable):
        disabled.chat_tools([], tools=[SEARCH_TOOL])
    assert len(requests) == 1


@pytest.mark.parametrize("calls", [
    [{"id": "call", "type": "function", "function": {"name": "write_file", "arguments": '{}'}}],
    [{"id": "call", "type": "function", "function": {"name": "search_knowledge", "arguments": '{"query":"政策","kb_ids":[]}'}}],
])
def test_native_planner_rejects_unknown_tools_and_scope_arguments(calls):
    class Gateway:
        llm_configured = True
        def chat_tools(self, *_args, **_kwargs):
            return {"tool_calls": calls}
    planner = SearchPlanner(settings(llm_supports_tools=True), "问题", gateway=Gateway())
    with pytest.raises(ValueError):
        planner.next_turn(3)
