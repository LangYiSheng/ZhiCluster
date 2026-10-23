import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import httpx
import pytest

from app.ai.gateway import ModelGateway
from app.ingestion.enrichment import classify_document, summarize_sections


def provider_settings(**overrides):
    return SimpleNamespace(**{
        "llm_base_url": "https://concurrency.invalid/v1", "llm_api_key": "test-key", "llm_model": "test-chat",
        "llm_max_retries": 0, "max_concurrent_model_calls": 3,
        "summary_input_tokens": 900, "summary_max_calls": 30,
        **overrides,
    })


def test_independent_gateways_share_limit_and_keep_interactive_capacity():
    lock = threading.Lock()
    release = threading.Event()
    two_background = threading.Event()
    interactive = threading.Event()
    active = peak = background_started = 0

    def respond(request):
        nonlocal active, peak, background_started
        background = json.loads(request.content)["messages"][0]["content"] == "background"
        with lock:
            active += 1
            peak = max(peak, active)
            if background:
                background_started += 1
                if background_started == 2:
                    two_background.set()
        try:
            if background:
                assert release.wait(3), "test failed to release blocked provider"
            else:
                interactive.set()
            return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})
        finally:
            with lock:
                active -= 1

    settings = provider_settings()
    transport = httpx.MockTransport(respond)
    background = [ModelGateway(settings, transport=transport, workload="background") for _ in range(3)]
    chat = ModelGateway(settings, transport=transport)
    assert all(gateway._limiter is chat._limiter for gateway in background)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(gateway.chat, [{"role": "user", "content": "background"}]) for gateway in background]
        try:
            assert two_background.wait(2)
            assert background_started == 2
            interactive_future = pool.submit(chat.chat, [{"role": "user", "content": "interactive"}])
            assert interactive.wait(2), "long ingestion blocked the reserved chat provider slot"
            assert interactive_future.result() == "OK"
            assert peak == 3
        finally:
            release.set()
        assert [future.result() for future in futures] == ["OK"] * 3


def test_hot_limit_change_has_independent_snapshot_and_reuses_matching_provider():
    first = ModelGateway(provider_settings(max_concurrent_model_calls=2))
    another_model = ModelGateway(provider_settings(max_concurrent_model_calls=2, llm_model="other-model"))
    changed = ModelGateway(provider_settings(max_concurrent_model_calls=1))
    assert first._limiter is another_model._limiter
    assert first._limiter is not changed._limiter
    with first._limiter.slot(background=True), changed._limiter.slot():
        assert first._limiter._active == changed._limiter._active == 1
    assert first._limiter._active == changed._limiter._active == 0


SUMMARY = {"short_summary": "研究短摘要", "detailed_summary": "研究详细摘要", "keywords": ["事实"], "main_topics": ["研究"]}


def test_small_document_many_sections_needs_one_call_not_one_call_per_anchor():
    class Gateway:
        def __init__(self):
            self.calls = []

        def chat(self, messages, *, json_mode=False, max_tokens=0):
            self.calls.append(messages[-1]["content"])
            assert json_mode
            return json.dumps(SUMMARY)

    gateway = Gateway()
    sections = [SimpleNamespace(plain_text=f"段落{i}：真实研究事实。", section_summary="") for i in range(20)]
    saved = []
    result = summarize_sections(sections, gateway, provider_settings(summary_input_tokens=6000), lambda *args: saved.append(args))
    assert result.model_dump() == SUMMARY
    assert len(gateway.calls) == 1
    assert "段落0" in gateway.calls[0] and "段落19" in gateway.calls[0]
    assert saved == []  # Never attribute a whole-document summary to individual paragraphs.


def test_large_section_map_overlaps_and_checkpoints_only_on_caller_thread():
    both_started = threading.Event()
    lock = threading.Lock()
    coordinator = threading.get_ident()
    workers = set()
    count = 0

    class Gateway:
        def chat(self, messages, *, json_mode=False, max_tokens=0):
            nonlocal count
            if json_mode:
                return json.dumps(SUMMARY)
            with lock:
                workers.add(threading.get_ident())
                count += 1
                if count >= 2:
                    both_started.set()
            assert both_started.wait(2), "section maps did not overlap"
            return "独立章节中的关键事实。"

    sections = [SimpleNamespace(plain_text="文档中的证据内容。" * 120, section_summary="") for _ in range(3)]
    saved = []

    def save(index, summary):
        assert threading.get_ident() == coordinator
        saved.append((index, summary))

    result = summarize_sections(sections, Gateway(), provider_settings(), save)
    assert result.keywords == ["事实"]
    assert len(workers) == 2
    assert {index for index, _ in saved} == {0, 1, 2}


@pytest.mark.parametrize("repetitions", [1, 45, 130])
def test_direct_summary_matches_information_size_and_preserves_json_headroom(repetitions):
    requests = []

    class Gateway:
        def chat(self, messages, *, json_mode=False, max_tokens=0):
            requests.append((messages, max_tokens))
            assert json_mode
            return json.dumps(SUMMARY)

    text = "资料说明：申请时间为九月，需提交成绩单和申请表。" * repetitions
    result = summarize_sections([SimpleNamespace(plain_text=text, section_summary="")], Gateway(), provider_settings(summary_input_tokens=6000))
    assert result.model_dump() == SUMMARY
    assert len(requests) == 1
    messages, output_budget = requests[0]
    prompt = messages[0]["content"]
    assert "信息量" in prompt and "不得扩写凑字" in prompt
    assert "100-200" not in prompt and "300-800" not in prompt
    assert 700 <= output_budget <= 1400
    if repetitions == 1:
        assert output_budget == 700
    if repetitions == 130:
        assert output_budget > 700


def test_classification_requests_concise_factual_summary_and_reason():
    class Gateway:
        def chat(self, messages, *, json_mode=False, max_tokens=0):
            assert json_mode
            prompt = messages[-1]["content"]
            assert "short_summary 与 reason 简洁陈述资料事实" in prompt
            assert "无需扩写凑字" in prompt
            return json.dumps({"existing_folder_id": None, "existing_tag_ids": [], "new_tag_names": [],
                               "short_summary": "九月申请。", "reason": "资料说明申请时间。"})

    result = classify_document("申请说明", "九月申请。", [], [], Gateway())
    assert result.short_summary == "九月申请。"
