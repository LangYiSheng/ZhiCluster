"""Real scoped document tools, honest activity, and historical replay contracts."""

import json

import pytest
from sqlalchemy import delete, select
from test_chat_scoped_tools import hierarchy, tag_document
from test_chat_tools import settings, source, start_chat

from app.ai.gateway import ModelGateway
from app.core.errors import AppError
from app.db.models import (
    ConversationEvent,
    Document,
    DocumentChunk,
    DocumentSection,
    DocumentTag,
    Message,
    utcnow,
)
from app.retrieval.chat_tools import model_retrieval
from app.retrieval.search import search_knowledge
from app.retrieval.tool_activity import visible_execution
from app.retrieval.tool_documents import MAX_READ_RESPONSE_CHARS, ScopedDocuments
from app.retrieval.tool_scope import ReadOnlyScope
from app.services.chat import process_chat_job
from app.services.chat_context import ExecutionSteps
from app.services.permissions import get_actor


def policy(db, kb_id, folder_id=None):
    doc, chunk = source(db, kb_id, "第一章：申请条件与说明。", folder_id=folder_id, ext="pdf")
    doc.display_name = "政策名额.pdf"
    doc.short_summary = "SUMMARY_IS_NOT_EVIDENCE"
    chunk.anchors = {"page_start": 1, "page_end": 1}
    db.get(DocumentSection, chunk.section_id).anchors = chunk.anchors
    for number, text in [(2, "第二章：普通推免144人，专项推免21人，合计165人。"), (3, "第三章：提交材料与复核程序。")]:
        section = DocumentSection(kb_id=kb_id, document_id=doc.id, heading=f"第{number}章", order=number,
            plain_text=text, anchors={"page_start": number, "page_end": number})
        db.add(section)
        db.flush()
        db.add(DocumentChunk(kb_id=kb_id, document_id=doc.id, section_id=section.id, chunk_index=number - 1,
            content=text, token_count=len(text), anchors=section.anchors))
    db.flush()
    return doc


def test_document_tools_require_discovery_and_preserve_narrow_origin(factory):
    with factory() as db:
        kb, _, child, elsewhere, tag, _, _ = hierarchy(db)
        doc = policy(db, kb.id, child.id)
        tag_document(db, doc, tag)
        hidden, _ = source(db, kb.id, "OUTSIDE_SECRET", folder_id=elsewhere.id)
        db.commit()
        tools = ScopedDocuments(ReadOnlyScope(db, get_actor(db), {"kb_ids": [kb.id]}))
        with pytest.raises(AppError):
            tools.read(doc.id)
        listing, _ = tools.list(fields={"folder_ids": [child.id], "tag_ids": [tag.id]}, query="政策")
        assert [row["document_id"] for row in listing["items"]] == [doc.id]
        assert "SUMMARY_IS_NOT_EVIDENCE" not in str(listing)
        outline, _ = tools.outline(doc.id, limit=2)
        assert len(outline["items"]) == 2 and outline["next_offset"] == 2
        payload, hits, origins = tools.read(doc.id, page=2)
        assert len(payload["items"]) == len(hits) == 1 and "165人" in payload["items"][0]["content"]
        assert len(json.dumps(payload, ensure_ascii=False)) <= MAX_READ_RESPONSE_CHARS
        assert origins[0]["folder_ids"] == [child.id]
        with pytest.raises(AppError):
            tools.outline(hidden.id)
        with pytest.raises(AppError):
            tools.read(doc.id, section_ids=["invented-section"])
        db.execute(delete(DocumentTag).where(DocumentTag.document_id == doc.id))
        db.commit()
        with pytest.raises(AppError):
            tools.read(doc.id, page=2)


@pytest.mark.parametrize("native", [False, True])
def test_real_discovery_outline_read_then_search_keeps_evidence_and_planning_private(client, factory, monkeypatch, native):
    with factory() as db:
        kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
        doc = policy(db, kb_id)
        db.commit()
        doc_id = doc.id
    _, _, _, conversation_id, message_id, job_id = start_chat(client, factory)
    turns = []

    def plan(_self, messages, **options):
        turns.append(messages)
        assert "on_content" not in options
        if len(turns) == 1:
            calls = [("list_documents", {"query": "政策名额"})]
        elif len(turns) == 2:
            assert doc_id in str(messages)
            calls = [("search_knowledge", {"query": "推免名额"}), ("get_document_outline", {"document_id": doc_id})]
        elif len(turns) == 3:
            assert "document_outline" in str(messages)
            calls = [("read_document", {"document_id": doc_id, "page": 2})]
        elif len(turns) == 4:
            assert "普通推免144人" in str(messages)
            calls = [("search_knowledge", {"query": "提交材料"})]
        else:
            calls = []
        if native:
            return {"role": "assistant", "content": "PRIVATE_PLANNING_TEXT 不能进入最终回答", "tool_calls": [
                {"id": f"call-{len(turns)}-{index}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                for index, (name, args) in enumerate(calls)]}
        return json.dumps({"searches": [args for name, args in calls if name == "search_knowledge"],
            "metadata": [{"tool": name, "arguments": args} for name, args in calls if name != "search_knowledge"]})

    def final(_self, messages, **_options):
        assert "普通推免144人" in str(messages)
        assert "PRIVATE_PLANNING_TEXT" not in str(messages)
        assert "SUMMARY_IS_NOT_EVIDENCE" not in str(messages)
        facts_message = next(item for item in messages if "<completed_tool_activity>" in item["content"])
        assert facts_message["role"] == "system"
        facts = json.loads(facts_message["content"].split("<completed_tool_activity>\n", 1)[1].split("\n</completed_tool_activity>", 1)[0])
        assert {tool["name"]: tool["calls"] for tool in facts["tools"]} == {
            "list_documents": 1, "search_knowledge": 2, "get_document_outline": 1, "read_document": 1}
        assert "PRIVATE_PLANNING_TEXT" not in facts_message["content"]
        assert doc_id not in facts_message["content"] and "政策名额.pdf" not in facts_message["content"]
        assert "get_current_scope" not in facts_message["content"] and "list_scope_metadata" not in facts_message["content"]
        yield "普通144人、专项21人，合计165人。[S1]"

    monkeypatch.setattr(ModelGateway, "chat_tools" if native else "chat", plan)
    monkeypatch.setattr(ModelGateway, "stream_chat", final)
    process_chat_job(job_id, factory, settings(llm_supports_tools=native), owner="current")
    with factory() as db:
        answer = db.get(Message, message_id)
        assert answer.status == "completed" and "PRIVATE_PLANNING_TEXT" not in answer.content
        assert answer.retrieval["tool_usage"]["document_calls"] == 3
        assert answer.retrieval["tool_usage"]["search_rounds"] == 2
        activities = [step for step in answer.retrieval["execution"] if step["stage"] == "tool_activity"]
        assert len(activities) == 5 and all(step["status"] == "completed" for step in activities)
        read = next(step for step in activities if step["tool_name"] == "read_document")
        assert read["source"]["anchors"] == {"page_start": 2, "page_end": 2}
        events = list(db.scalars(select(ConversationEvent).where(ConversationEvent.conversation_id == conversation_id)))
        assert all(event.data["retrieval_mode"] == "model" for event in events if event.type != "status" or event.data.get("reset"))
    snapshot = client.get(f"/api/conversations/{conversation_id}/messages").json()[-1]
    assert "_source_scopes" not in str(snapshot)
    assert "_activity_scope" not in str(snapshot)
    assert next(step for step in snapshot["retrieval"]["execution"] if step.get("tool_name") == "read_document")["source"]["available"]


@pytest.mark.parametrize("change", ["move", "untag", "delete"])
def test_activity_snapshot_and_sse_mask_stale_document_source(client, factory, change):
    with factory() as db:
        kb, _, child, elsewhere, tag, _, _ = hierarchy(db)
        doc, chunk = source(db, kb.id, "PRIVATE_SOURCE_CONTENT", folder_id=child.id)
        tag_document(db, doc, tag)
        db.commit()
        kb_id, doc_id, chunk_id = kb.id, doc.id, chunk.id
        original = ReadOnlyScope(db, get_actor(db), {"kb_ids": [kb_id]}).narrow({"folder_ids": [child.id], "tag_ids": [tag.id]})
    _, _, _, conversation_id, message_id, job_id = start_chat(client, factory)
    activity = {"stage": "tool_activity", "tool_name": "read_document", "call_id": "read-one", "status": "completed",
        "label": "阅读原文", "document_id": doc_id, "document_name": "OLD_PRIVATE_NAME", "detail": "OLD_PRIVATE_NAME",
        "_source_scopes": [original], "source": {"ordinal": 0, "document_id": doc_id, "chunk_id": chunk_id,
            "document_name": "OLD_PRIVATE_NAME", "snippet": "PRIVATE_SOURCE_CONTENT", "anchors": {"paragraph": 1}}}
    with factory() as db:
        from app.db.models import IngestionJob
        message = db.get(Message, message_id)
        message.status = "completed"
        message.retrieval = {"execution": [activity], "retrieval_mode": "model"}
        db.get(IngestionJob, job_id).status = "completed"
        db.add(ConversationEvent(conversation_id=conversation_id, sequence=2, type="progress", data={"message_id": message_id, "steps": [activity]}))
        if change == "move":
            db.get(Document, doc_id).folder_id = elsewhere.id
        elif change == "untag":
            db.execute(delete(DocumentTag).where(DocumentTag.document_id == doc_id))
        else:
            db.get(Document, doc_id).deleted_at = utcnow()
        db.commit()
    snapshots = client.get(f"/api/conversations/{conversation_id}/messages").json()
    activity = snapshots[-1]["retrieval"]["execution"][0]
    assert activity["available"] is False
    replay = client.get(f"/api/conversations/{conversation_id}/events").text
    for payload in (str(snapshots), replay):
        assert "OLD_PRIVATE_NAME" not in payload and "PRIVATE_SOURCE_CONTENT" not in payload
        assert "_source_scopes" not in payload


def test_tool_activity_remains_running_during_internal_search_and_deduplicates(factory):
    execution = ExecutionSteps()
    with factory() as db:
        kb_id = db.scalar(select(Document.kb_id))
        if not kb_id:
            from app.db.models import KnowledgeBase
            kb_id = db.scalar(select(KnowledgeBase.id))
        source(db, kb_id, "名额165人")
        db.commit()
        class Planner:
            native, turn = False, 0
            def next_turn(self, _remaining):
                self.turn += 1
                return [{"query": "名额"}, {"query": "名额"}] if self.turn == 1 else []
            def feedback(self, _value):
                pass
        def search(request, callback):
            callback("embedding", {})
            activity = next(step for step in execution.snapshot() if step["stage"] == "tool_activity")
            assert activity["status"] == "running"
            return search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, settings())
        model_retrieval(db, get_actor(db), {"kb_ids": [kb_id]}, "名额", settings(), planner=Planner(),
            search=search, progress=execution.advance, check_active=lambda: None)
        activities = [step for step in execution.snapshot() if step["stage"] == "tool_activity"]
        assert len(activities) == 2 and all(step["status"] == "completed" for step in activities)
        assert activities[1]["detail"] == "相同条件已查阅，沿用已有结果"
        assert activities[0]["scope_label"]


def test_source_permission_revocation_removes_activity_data(factory):
    with factory() as db:
        from app.db.models import KnowledgeBase, KnowledgeBaseMember
        kb = db.scalar(select(KnowledgeBase))
        doc, chunk = source(db, kb.id, "PRIVATE_CONTENT")
        db.commit()
        step = {"stage": "tool_activity", "document_id": doc.id, "document_name": "PRIVATE_NAME",
            "source": {"ordinal": 0, "document_id": doc.id, "chunk_id": chunk.id, "snippet": "PRIVATE_CONTENT"}}
        db.execute(delete(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == kb.id))
        db.commit()
        result = visible_execution(db, get_actor(db), {"kb_ids": [kb.id]}, [step])[0]
        assert result["available"] is False and "PRIVATE" not in str(result)


@pytest.mark.parametrize("native", [False, True])
def test_last_search_budget_still_allows_document_read(factory, monkeypatch, native):
    from app.db.models import KnowledgeBase
    from app.retrieval.chat_tools import SearchPlanner

    with factory() as db:
        kb_id = db.scalar(select(KnowledgeBase.id))
        doc = policy(db, kb_id)
        db.commit()
        turns = []
        def plan(_self, messages, **_kwargs):
            turns.append(messages)
            if len(turns) == 1:
                calls = [("search_knowledge", {"query": query}) for query in ["名额", "普通推免", "专项推免"]]
            elif len(turns) == 2:
                assert "还可搜索0次" in str(messages)
                calls = [("read_document", {"document_id": doc.id, "page": 2})]
            else:
                calls = []
            if native:
                return {"role": "assistant", "content": "", "tool_calls": [{"id": f"{len(turns)}-{index}", "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)}} for index, (name, args) in enumerate(calls)]}
            return json.dumps({"tools": [{"tool": name, "arguments": args} for name, args in calls]})
        monkeypatch.setattr(ModelGateway, "chat_tools" if native else "chat", plan)
        planner = SearchPlanner(settings(llm_supports_tools=native), "名额", scope_snapshot=ReadOnlyScope(db, get_actor(db), {"kb_ids": [kb_id]}).snapshot())
        result = model_retrieval(db, get_actor(db), {"kb_ids": [kb_id]}, "名额", settings(), planner=planner,
            search=lambda request, callback: search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, settings()),
            progress=lambda *_args, **_kwargs: None, check_active=lambda: None)
        assert len(turns) == 3 and result["model_retrieval"]["searches"] == 3
        assert result["tool_usage"]["document_calls"] == 1 and "165人" in result["items"][0]["content"]


def test_invalid_read_arguments_never_trigger_broader_fallback(client, factory, monkeypatch):
    _, _, _, _, message_id, job_id = start_chat(client, factory)
    monkeypatch.setattr(ModelGateway, "chat", lambda *_args, **_kwargs: json.dumps({"tools": [
        {"tool": "read_document", "arguments": {"document_id": "invented", "section_ids": []}}]}))
    import app.services.chat as chat
    monkeypatch.setattr(chat, "search_knowledge", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("no broad search")))
    process_chat_job(job_id, factory, settings(), owner="current")
    with factory() as db:
        message = db.get(Message, message_id)
        assert message.status == "completed" and "找不到足够依据" in message.content


def test_failed_planning_after_two_search_rounds_never_creates_a_third(factory):
    from app.ai.gateway import ProviderError
    from app.db.models import KnowledgeBase

    with factory() as db:
        kb_id = db.scalar(select(KnowledgeBase.id))
        source(db, kb_id, "政策名额165人")
        db.commit()
        calls = []
        class Planner:
            native, turn = False, 0
            def next_turn(self, _remaining):
                self.turn += 1
                if self.turn == 3:
                    raise ProviderError("controlled timeout", code="read_timeout")
                return [{"query": "政策" if self.turn == 1 else "名额"}]
            def feedback(self, _payload):
                pass
        def search(request, callback):
            calls.append(request["query"])
            return search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, settings())
        result = model_retrieval(db, get_actor(db), {"kb_ids": [kb_id]}, "原问题", settings(), planner=Planner(),
            search=search, progress=lambda *_args, **_kwargs: None, check_active=lambda: None)
        assert calls == ["政策", "名额"]
        assert result["tool_usage"]["search_rounds"] == 2 and result["model_retrieval"]["searches"] == 2
        assert result["model_retrieval"]["fallback"] and result["items"]


def test_fast_answer_receives_only_the_actual_completed_search_fact(client, factory, monkeypatch):
    _, _, _, _, message_id, job_id = start_chat(client, factory, retrieval_mode="direct")
    captured = []
    def final(_self, messages, **_options):
        facts_message = next(item for item in messages if "<completed_tool_activity>" in item["content"])
        facts = json.loads(facts_message["content"].split("<completed_tool_activity>\n", 1)[1].split("\n</completed_tool_activity>", 1)[0])
        captured.append(facts)
        assert facts == {"tools": [{"name": "search_knowledge", "action": "搜索知识库", "calls": 1}]}
        assert facts_message["role"] == "system" and "read_document" not in facts_message["content"]
        yield "名额28人。[S1]"
    monkeypatch.setattr(ModelGateway, "stream_chat", final)
    process_chat_job(job_id, factory, settings(), owner="current")
    assert len(captured) == 1
    with factory() as db:
        assert db.get(Message, message_id).status == "completed"


def test_generation_tool_facts_ignore_unavailable_failed_unknown_and_private_fields(factory):
    from app.db.models import KnowledgeBase
    from app.services.chat import completed_tool_context

    with factory() as db:
        kb_id = db.scalar(select(KnowledgeBase.id))
        doc, chunk = source(db, kb_id, "PRIVATE_SOURCE_BODY")
        db.commit()
        base = {"stage": "tool_activity", "tool_name": "read_document", "call_id": "real-read", "status": "completed",
            "document_id": doc.id, "document_name": "PRIVATE_NAME", "source_count": 1, "query": "PRIVATE_QUERY",
            "detail": "PRIVATE_DETAIL", "source": {"ordinal": 0, "document_id": doc.id, "chunk_id": chunk.id},
            "_source_scopes": [{"kb_ids": [kb_id]}]}
        trace = [base, {**base}, {**base, "call_id": "running-read", "status": "running"},
            {**base, "call_id": "failed-read", "status": "failed"},
            {**base, "call_id": "unknown", "tool_name": "execute_shell"}]
        text = completed_tool_context(db, get_actor(db), {"kb_ids": [kb_id]}, trace)
        assert '"name":"read_document"' in text and '"calls":1' in text
        assert "PRIVATE" not in text and "execute_shell" not in text and doc.id not in text
        db.get(Document, doc.id).deleted_at = utcnow()
        db.commit()
        masked = completed_tool_context(db, get_actor(db), {"kb_ids": [kb_id]}, trace)
        assert '"tools":[]' in masked and '"name":"read_document"' not in masked
