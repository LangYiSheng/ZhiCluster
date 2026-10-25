"""Planning time limits are per-request snapshots with an independent total budget."""

import json

import pytest
from sqlalchemy import select
from test_chat_tools import settings, source

from app.ai.gateway import ProviderError
from app.db.models import KnowledgeBase
from app.retrieval import chat_tools
from app.retrieval.chat_tools import SearchPlanner, model_retrieval
from app.retrieval.search import search_knowledge
from app.services.permissions import get_actor


@pytest.mark.parametrize("saved_timeout,remaining,expected", [(120, 90, 30), (8, 90, 8), (120, 4.5, 4.5)])
def test_each_real_gateway_uses_bounded_settings_copy(monkeypatch, saved_timeout, remaining, expected):
    calls = []
    class Gateway:
        llm_configured = True
        def __init__(self, snapshot):
            self.settings = snapshot
        def chat(self, *_args, **_kwargs):
            calls.append(self.settings)
            return '{"tools":[]}'
    monkeypatch.setattr(chat_tools, "ModelGateway", Gateway)
    original = settings(llm_timeout_seconds=saved_timeout, llm_max_retries=2)
    planner = SearchPlanner(original, "名额")
    planner.planning_seconds_remaining = remaining
    assert planner.next_turn(3) == []
    assert calls[0].llm_timeout_seconds == expected and calls[0].llm_max_retries == 0
    assert calls[0] is not original
    assert original.llm_timeout_seconds == saved_timeout and original.llm_max_retries == 2


def test_injected_gateway_is_retained_and_zero_budget_never_calls_it():
    class Gateway:
        llm_configured, calls = True, 0
        def chat(self, *_args, **_kwargs):
            self.calls += 1
            return '{"tools":[]}'
    gateway = Gateway()
    planner = SearchPlanner(settings(), "名额", gateway=gateway)
    planner.planning_seconds_remaining = 2
    assert planner.next_turn(3) == []
    assert planner.gateway is gateway and gateway.calls == 1
    planner.planning_seconds_remaining = 0
    with pytest.raises(ProviderError) as error:
        planner.next_turn(3)
    assert error.value.code == "planning_budget_exhausted" and gateway.calls == 1


def test_remaining_total_budget_shrinks_later_requests_without_counting_tool_time(factory, monkeypatch):
    clock, timeouts = [0.0], []
    durations = [29, 29, 25, 4]
    class Gateway:
        llm_configured = True
        def __init__(self, snapshot):
            self.settings = snapshot
        def chat(self, *_args, **_kwargs):
            timeouts.append(self.settings.llm_timeout_seconds)
            clock[0] += durations[len(timeouts) - 1]
            return json.dumps({"metadata": [{"tool": "get_current_scope", "arguments": {}}] if len(timeouts) < 4 else []})
    monkeypatch.setattr(chat_tools, "ModelGateway", Gateway)
    monkeypatch.setattr(chat_tools, "_planning_clock", lambda: clock[0])
    original = settings(llm_timeout_seconds=120, llm_max_retries=2)
    with factory() as db:
        kb_id = db.scalar(select(KnowledgeBase.id))
        source(db, kb_id, "政策名额165人")
        db.commit()
        def progress(*_args, **_kwargs):
            clock[0] += 1000  # Persistence/tools do not spend model planning time.
        result = model_retrieval(db, get_actor(db), {"kb_ids": [kb_id]}, "政策", original,
            search=lambda request, callback: search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, original),
            progress=progress, check_active=lambda: None)
    assert timeouts == [30, 30, 30, 7]
    assert result["tool_usage"]["model_turns"] == 4 and result["items"]
    assert original.llm_timeout_seconds == 120 and original.llm_max_retries == 2


def test_custom_planner_stops_at_total_budget_and_preserves_found_sources(factory, monkeypatch):
    clock, steps, queries = [0.0], [], []
    class Planner:
        native, calls = False, 0
        def next_turn(self, _remaining):
            self.calls += 1
            clock[0] += 45
            return [{"query": "政策" if self.calls == 1 else "名额"}]
        def feedback(self, _calls):
            pass
    monkeypatch.setattr(chat_tools, "_planning_clock", lambda: clock[0])
    with factory() as db:
        kb_id = db.scalar(select(KnowledgeBase.id))
        source(db, kb_id, "政策名额165人")
        db.commit()
        def search(request, callback):
            queries.append(request["query"])
            return search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, settings())
        planner = Planner()
        result = model_retrieval(db, get_actor(db), {"kb_ids": [kb_id]}, "原问题", settings(), planner=planner,
            search=search, progress=lambda stage, label, **details: steps.append((stage, details)), check_active=lambda: None)
    assert planner.calls == 2 and queries == ["政策", "名额"]
    assert result["items"] and result["model_retrieval"]["fallback"]
    assert any(stage == "retrieval_fallback" and details["error_code"] == "planning_budget_exhausted" for stage, details in steps)


def test_failed_planning_time_is_measured_in_finally(factory, monkeypatch):
    clock, readings = [0.0], []
    def read_clock():
        readings.append(clock[0])
        return clock[0]
    class Planner:
        native = False
        def next_turn(self, _remaining):
            clock[0] += 30
            raise ProviderError("controlled timeout", code="read_timeout")
    monkeypatch.setattr(chat_tools, "_planning_clock", read_clock)
    with factory() as db:
        kb_id = db.scalar(select(KnowledgeBase.id))
        source(db, kb_id, "政策名额165人")
        db.commit()
        result = model_retrieval(db, get_actor(db), {"kb_ids": [kb_id]}, "政策", settings(), planner=Planner(),
            search=lambda request, callback: search_knowledge(db, get_actor(db), {**request, "mode": "keyword"}, settings()),
            progress=lambda *_args, **_kwargs: None, check_active=lambda: None)
    assert readings == [0, 30] and result["items"]
