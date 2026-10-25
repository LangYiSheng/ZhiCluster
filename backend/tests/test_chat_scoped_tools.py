"""Real scope SQL, tool planning, pagination and citation lifecycle coverage."""

import json

import pytest
from sqlalchemy import delete, select
from test_chat_tools import settings, source, start_chat

from app.ai.gateway import ModelGateway
from app.core.errors import AppError
from app.db.models import Document, DocumentTag, Folder, KnowledgeBase, Message, MessageCitation, Tag
from app.retrieval.chat_tools import current_hits, merge_hits, model_retrieval
from app.retrieval.search import scoped_query, search_knowledge
from app.retrieval.tool_scope import (
    MAX_METADATA_RESPONSE_CHARS,
    MAX_SCOPE_SNAPSHOT_CHARS,
    ReadOnlyScope,
    scope_key,
)
from app.services.chat import process_chat_job
from app.services.permissions import get_actor


def hierarchy(db):
    kb = db.scalar(select(KnowledgeBase))
    parent = Folder(kb_id=kb.id, name="当前目录")
    elsewhere = Folder(kb_id=kb.id, name="范围外秘密目录")
    db.add_all([parent, elsewhere])
    db.flush()
    child = Folder(kb_id=kb.id, name="可选子目录", parent_id=parent.id)
    a, b, c = [Tag(kb_id=kb.id, name=name, normalized_name=name) for name in ("标签A", "标签B", "标签C")]
    db.add_all([child, a, b, c])
    db.flush()
    return kb, parent, child, elsewhere, a, b, c


def tag_document(db, doc, *tags):
    db.add_all([DocumentTag(kb_id=doc.kb_id, document_id=doc.id, tag_id=tag.id) for tag in tags])
    db.flush()


def documents(db, actor, scope):
    stmt, _ = scoped_query(db, actor, scope)
    return {doc.id for _chunk, doc in db.execute(stmt)}


def test_scope_override_only_inherits_and_intersects_original_folder_and_tags(factory):
    with factory() as db:
        kb, parent, child, _, a, b, c = hierarchy(db)
        root, _ = source(db, kb.id, "政策", folder_id=parent.id)
        nested, _ = source(db, kb.id, "政策", folder_id=child.id)
        only_a, _ = source(db, kb.id, "政策", folder_id=child.id)
        tag_document(db, root, a, b, c)
        tag_document(db, nested, a, b, c)
        tag_document(db, only_a, a)
        db.commit()
        actor = get_actor(db)
        fixed = {"kb_ids": [kb.id], "folder_ids": [parent.id], "include_descendants": True,
            "tag_ids": [a.id, b.id], "tag_match": "any"}
        view = ReadOnlyScope(db, actor, fixed)
        assert documents(db, actor, view.narrow({"include_descendants": False})) == {root.id}
        assert documents(db, actor, view.narrow({"tag_match": "all"})) == {root.id, nested.id}
        assert documents(db, actor, view.narrow({"folder_ids": [child.id], "tag_ids": [c.id]})) == {nested.id}
        strict = ReadOnlyScope(db, actor, {**fixed, "tag_match": "all"})
        assert documents(db, actor, strict.narrow({"tag_ids": [a.id], "tag_match": "any"})) == {root.id, nested.id}
        direct_only = ReadOnlyScope(db, actor, {**fixed, "include_descendants": False})
        assert documents(db, actor, direct_only.narrow({"include_descendants": True})) == {root.id}
        with pytest.raises(AppError, match="范围"):
            direct_only.narrow({"folder_ids": [child.id]})


def test_scope_metadata_is_private_bounded_searchable_and_pageable(factory):
    with factory() as db:
        kb, parent, child, elsewhere, a, _, _ = hierarchy(db)
        visible, _ = source(db, kb.id, "SECRET_BODY", folder_id=child.id)
        hidden, _ = source(db, kb.id, "OUTSIDE_BODY", folder_id=elsewhere.id)
        hidden_tag = Tag(kb_id=kb.id, name="范围外秘密标签", normalized_name="范围外秘密标签")
        db.add(hidden_tag)
        db.flush()
        tag_document(db, visible, a)
        tag_document(db, hidden, hidden_tag)
        db.add_all([Folder(kb_id=kb.id, parent_id=parent.id, name=f"目录{index:03d}" + "长" * 155) for index in range(65)])
        db.commit()
        view = ReadOnlyScope(db, get_actor(db), {"kb_ids": [kb.id], "folder_ids": [parent.id]})
        pages, offset = [], 0
        while offset is not None:
            page = view.metadata("folders", offset=offset, limit=30)
            assert len(json.dumps(page, ensure_ascii=False)) <= MAX_METADATA_RESPONSE_CHARS
            assert 0 < len(page["items"]) <= 30
            pages.extend(page["items"])
            offset = page["next_offset"]
        assert len(pages) == 67 and len({row["id"] for row in pages}) == 67
        assert elsewhere.id not in {row["id"] for row in pages}
        roots = view.metadata("folders", parent_filter=True, parent_id=None)
        assert [row["id"] for row in roots["items"]] == [parent.id]
        assert view.metadata("folders", query="可选")["items"][0]["id"] == child.id
        assert [row["id"] for row in view.metadata("tags")["items"]] == [a.id]
        assert "SECRET_BODY" not in str(view.snapshot()) + str(pages)
        with pytest.raises(AppError):
            view.metadata("folders", parent_id=elsewhere.id)
        with pytest.raises(AppError):
            view.metadata("knowledge_bases", kb_id="outside")


def test_scope_snapshot_caps_names_and_five_hundred_document_ids(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        folders = [Folder(kb_id=kb.id, name=f"选中{index}" + "长" * 200) for index in range(40)]
        tags = [Tag(kb_id=kb.id, name=f"标签{index}" + "长" * 90, normalized_name=f"标签{index}") for index in range(30)]
        db.add_all(folders + tags)
        db.commit()
        fixed = {"kb_ids": [kb.id], "folder_ids": [row.id for row in folders], "tag_ids": [row.id for row in tags],
            "document_ids": [f"document-{index:04d}" for index in range(500)]}
        payload = ReadOnlyScope(db, get_actor(db), fixed).snapshot()
        serialized = json.dumps(payload, ensure_ascii=False)
        assert len(serialized) <= MAX_SCOPE_SNAPSHOT_CHARS
        assert payload["filters"]["document_count"] == 500 and "document-0000" not in serialized
        assert payload["selected_folders_total"] == 40 and payload["metadata_truncated"]


@pytest.mark.parametrize("native", [False, True])
def test_metadata_then_filtered_searches_use_real_tools_and_keep_scope_summaries(client, factory, monkeypatch, native):
    with factory() as db:
        kb, parent, child, elsewhere, a, _, _ = hierarchy(db)
        doc, _ = source(db, kb.id, "年度申请政策采用公开综合考核。名额28人。", folder_id=child.id)
        hidden, _ = source(db, kb.id, "范围外秘密正文名额99人。", folder_id=elsewhere.id)
        tag_document(db, doc, a)
        db.commit()
        identifiers = kb.id, parent.id, child.id, a.id, doc.id, hidden.id
    kb_id, parent_id, child_id, tag_id, document_id, hidden_id = identifiers
    _, _, _, _, message_id, job_id = start_chat(client, factory, scope={"kb_ids": [kb_id], "folder_ids": [parent_id]})
    turns = []

    def plan(_self, messages, **options):
        turns.append(messages.copy())
        if native:
            assert {tool["function"]["name"] for tool in options["tools"]} == {
                "search_knowledge", "get_current_scope", "list_scope_metadata"}
        if len(turns) == 1:
            calls = [("list_scope_metadata", {"kind": "folders"}), ("list_scope_metadata", {"kind": "tags"})]
        elif len(turns) == 2:
            tool_data = " ".join(item.get("content") or "" for item in messages if item["role"] in {"tool", "user"})
            assert child_id in tool_data and tag_id in tool_data
            assert "范围外秘密" not in tool_data
            calls = [("search_knowledge", {"query": "申请政策", "folder_ids": [child_id]}),
                ("search_knowledge", {"query": "名额", "tag_ids": [tag_id]})]
        else:
            assert "source_count" in str(messages)
            calls = []
        if native:
            return {"role": "assistant", "content": "", "tool_calls": [{"id": f"call-{len(turns)}-{index}", "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)}} for index, (name, args) in enumerate(calls)]}
        return json.dumps({"searches": [args for name, args in calls if name == "search_knowledge"],
            "metadata": [{"tool": name, "arguments": args} for name, args in calls if name != "search_knowledge"]})

    def stream(_self, messages, **_kwargs):
        assert "名额28人" in str(messages) and "范围外秘密" not in str(messages)
        yield "名额28人[S1]"

    monkeypatch.setattr(ModelGateway, "chat_tools" if native else "chat", plan)
    monkeypatch.setattr(ModelGateway, "stream_chat", stream)
    process_chat_job(job_id, factory, settings(llm_supports_tools=native), owner="current")
    with factory() as db:
        message = db.get(Message, message_id)
        assert message.status == "completed" and len(turns) == 3
        assert message.retrieval["tool_usage"] == {"model_turns": 3, "search_rounds": 1, "metadata_calls": 2, "tool_calls": 4}
        summaries = [step for step in message.retrieval["execution"] if step["stage"] == "search_round_summary"]
        final = {step["scope_key"]: step for step in summaries}
        assert len(final) == 2 and {step["round"] for step in final.values()} == {1}
        assert {tuple(step["queries"]) for step in final.values()} == {("申请政策",), ("名额",)}
        assert all(step["source_count"] == 1 and step["status"] == "completed" for step in final.values())
        assert {citation.document_id for citation in db.scalars(select(MessageCitation).where(MessageCitation.message_id == message_id))} == {document_id}
        assert hidden_id not in str(message.retrieval)


@pytest.mark.parametrize("filters", [{"kb_ids": ["outside"]}, {"folder_ids": []}, {"tag_ids": ["outside"]}, {"document_ids": []}])
def test_invalid_requested_filters_never_broaden_to_direct_fallback(client, factory, monkeypatch, filters):
    _, _, _, _, message_id, job_id = start_chat(client, factory)
    monkeypatch.setattr(ModelGateway, "chat", lambda *_args, **_kwargs: json.dumps({"searches": [{"query": "政策", **filters}]}))
    monkeypatch.setattr(ModelGateway, "stream_chat", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("no broader evidence")))
    import app.services.chat as chat
    monkeypatch.setattr(chat, "search_knowledge", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("no broader search")))
    process_chat_job(job_id, factory, settings(), owner="current")
    with factory() as db:
        message = db.get(Message, message_id)
        assert message.status == "completed"
        summaries = [step for step in message.retrieval["execution"] if step["stage"] == "search_round_summary"]
        assert summaries and all(step["status"] == "failed" and step["source_count"] == 0 for step in summaries)
        assert not list(db.scalars(select(MessageCitation).where(MessageCitation.message_id == message_id)))


def test_hit_origin_union_does_not_contaminate_groups_and_rechecks_moved_and_untagged(factory):
    with factory() as db:
        kb, parent, child, elsewhere, a, _, _ = hierarchy(db)
        doc, _ = source(db, kb.id, "政策", folder_id=child.id)
        tag_document(db, doc, a)
        db.commit()
        actor, fixed = get_actor(db), {"kb_ids": [kb.id]}
        view = ReadOnlyScope(db, actor, fixed)
        folder_scope, tag_scope = view.narrow({"folder_ids": [child.id]}), view.narrow({"tag_ids": [a.id]})
        results = []
        for scope in (folder_scope, tag_scope):
            result = search_knowledge(db, actor, {**scope, "query": "政策", "mode": "keyword"}, settings())
            result["items"] = [{**hit, "_search_scopes": [scope]} for hit in result["items"]]
            results.append(result)
        merged = merge_hits(results)
        assert len(merged) == 1 and len(merged[0]["_search_scopes"]) == 2
        assert all(len(result["items"][0]["_search_scopes"]) == 1 for result in results)
        with factory() as writer:
            writer.get(Document, doc.id).folder_id = elsewhere.id
            writer.commit()
        available = current_hits(db, actor, fixed, merged)
        assert len(available) == 1 and [scope_key(scope) for scope in available[0]["_search_scopes"]] == [scope_key(tag_scope)]
        assert current_hits(db, actor, fixed, results[0]["items"]) == []
        with factory() as writer:
            writer.execute(delete(DocumentTag).where(DocumentTag.document_id == doc.id))
            writer.commit()
        assert current_hits(db, actor, fixed, merged) == []


def test_metadata_and_planning_turn_budgets_leave_room_for_last_search(factory):
    with factory() as db:
        kb = db.scalar(select(KnowledgeBase))
        source(db, kb.id, "政策")
        db.commit()
        class Planner:
            native, turns = False, 0
            def next_turn(self, remaining):
                self.turns += 1
                assert remaining == 3
                return [{"tool_name": "get_current_scope"}] if self.turns <= 3 else [{"query": "政策"}]
            def feedback(self, calls):
                assert len(json.dumps([payload for _call, payload in calls], ensure_ascii=False)) < 6000
        planner = Planner()
        result = model_retrieval(db, get_actor(db), {"kb_ids": [kb.id]}, "政策", settings(), planner=planner,
            search=lambda request, callback: search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, settings()),
            progress=lambda *_args, **_kwargs: None, check_active=lambda: None)
        assert result["tool_usage"] == {"model_turns": 4, "search_rounds": 1, "metadata_calls": 3, "tool_calls": 4}
        assert len(result["items"]) == 1


def test_direct_mode_uses_same_round_scope_and_distinct_count(client, factory, monkeypatch):
    _, _, _, _, message_id, job_id = start_chat(client, factory, retrieval_mode="direct")
    monkeypatch.setattr(ModelGateway, "stream_chat", lambda *_args, **_kwargs: iter(["回答[S1]"]))
    process_chat_job(job_id, factory, settings(), owner="current")
    with factory() as db:
        steps = db.get(Message, message_id).retrieval["execution"]
        search = next(step for step in steps if step["stage"] == "search")
        summary = next(step for step in steps if step["stage"] == "search_round_summary")
        assert search["round"] == summary["round"] == 1
        assert search["scope_key"] == summary["scope_key"] and search["scope_label"] == summary["scope_label"]
        assert summary["queries"] == [search["query"]] and summary["source_count"] == 1 and summary["status"] == "completed"


@pytest.mark.parametrize("change", ["move", "untag", "delete_filter"])
def test_narrowed_source_changed_during_generation_loses_final_citation(client, factory, monkeypatch, change):
    with factory() as db:
        kb, _, child, elsewhere, a, _, _ = hierarchy(db)
        doc, _ = source(db, kb.id, "年度申请政策名额28人", folder_id=child.id)
        tag_document(db, doc, a)
        db.commit()
        kb_id, child_id, elsewhere_id, tag_id, doc_id = kb.id, child.id, elsewhere.id, a.id, doc.id
    _, _, _, _, message_id, job_id = start_chat(client, factory, scope={"kb_ids": [kb_id]})
    turns = []

    def plan(*_args, **_kwargs):
        turns.append(1)
        return json.dumps({"searches": [{"query": "申请政策", "folder_ids": [child_id], "tag_ids": [tag_id]}] if len(turns) == 1 else []})

    def stream(*_args, **_kwargs):
        with factory() as writer:
            if change == "move":
                writer.get(Document, doc_id).folder_id = elsewhere_id
            elif change == "untag":
                writer.execute(delete(DocumentTag).where(DocumentTag.document_id == doc_id))
            else:
                writer.execute(delete(DocumentTag).where(DocumentTag.tag_id == tag_id))
                writer.execute(delete(Tag).where(Tag.id == tag_id))
            writer.commit()
        yield "依据资料[S1]"

    monkeypatch.setattr(ModelGateway, "chat", plan)
    monkeypatch.setattr(ModelGateway, "stream_chat", stream)
    process_chat_job(job_id, factory, settings(), owner="current")
    with factory() as db:
        assert db.get(Message, message_id).content == "依据资料[引用无效]"
        assert not list(db.scalars(select(MessageCitation).where(MessageCitation.message_id == message_id)))


def test_same_query_with_different_filters_runs_but_identical_scope_is_deduplicated(factory):
    with factory() as db:
        kb, parent, child, _, a, _, _ = hierarchy(db)
        doc, _ = source(db, kb.id, "政策", folder_id=child.id)
        tag_document(db, doc, a)
        db.commit()
        class Planner:
            native, turns = False, 0
            def next_turn(self, _remaining):
                self.turns += 1
                if self.turns == 1:
                    return [{"query": "政策", "folder_ids": [parent.id]}, {"query": "政策", "folder_ids": [parent.id]},
                        {"query": "政策", "tag_ids": [a.id]}]
                return [{"query": "政策", "folder_ids": [child.id]}]
            def feedback(self, _calls):
                pass
        requests, steps = [], []
        def search(request, _callback):
            requests.append(request)
            return search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, settings())
        result = model_retrieval(db, get_actor(db), {"kb_ids": [kb.id]}, "政策", settings(), planner=Planner(), search=search,
            progress=lambda stage, _label, **fields: steps.append({"stage": stage, **fields}), check_active=lambda: None)
        assert len(requests) == 3 and len(result["items"]) == 1
        final = {(step["round"], step["scope_key"]): step for step in steps if step["stage"] == "search_round_summary"}
        assert len(final) == 3 and {key[0] for key in final} == {1, 2}
        assert all(step["queries"] == ["政策"] and step["source_count"] == 1 for step in final.values())
