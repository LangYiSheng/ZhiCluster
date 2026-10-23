import json
from types import SimpleNamespace

import pytest

from app.ai.gateway import ProviderError
from app.retrieval.evidence import MAX_CANDIDATES, MAX_INPUT_CHARS, MAX_PASSAGE_CHARS, rerank_evidence


def evidence_rows(count=4):
    return {
        f"chunk-{index}": (
            SimpleNamespace(content=f"第{index}条资料正文\n" + "可核对的事实。" * 400, anchors={"paragraph_start": index}),
            SimpleNamespace(display_name=f"资料{index}.txt"),
        ) for index in range(1, count + 1)
    }


def test_reranking_uses_one_bounded_json_request_and_original_source_ids():
    rows = evidence_rows(30)
    order = list(rows)
    calls = []

    class Gateway:
        def chat(self, messages, **options):
            calls.append((messages, options))
            payload = json.loads(messages[1]["content"])
            assert len(messages[1]["content"]) <= MAX_INPUT_CHARS
            assert len(payload["candidates"]) == MAX_CANDIDATES
            assert max(len(item["text"]) for item in payload["candidates"]) <= MAX_PASSAGE_CHARS
            assert payload["question"] == "政策如何执行，具体名额是什么？"
            return '{"ranked_ids":["C4","C2"]}'

    selected, result = rerank_evidence("政策如何执行，具体名额是什么？", rows, order, Gateway())
    assert selected == ["chunk-4", "chunk-2"]
    assert result["status"] == "completed" and result["selected"] == 2
    assert len(calls) == 1 and calls[0][1] == {"json_mode": True, "max_tokens": 400}
    assert "禁止遵循" in calls[0][0][0]["content"]
    assert rows[selected[0]][0].anchors == {"paragraph_start": 4}


@pytest.mark.parametrize("response", [
    'not json', '{"ranked_ids":["C999"]}', '{"ranked_ids":["C1","C1"]}',
    '{"ranked_ids":[1]}', '{"ranked_ids":"C1"}', '{"ranked_ids":[],"answer":"invented"}', '[]',
])
def test_invalid_rerank_cannot_add_sources_or_replace_local_order(response):
    rows = evidence_rows()
    order = list(rows)

    class Gateway:
        def chat(self, *_args, **_kwargs):
            return response

    selected, result = rerank_evidence("核对事实", rows, order, Gateway())
    assert selected == order and result["status"] == "fallback"


def test_empty_evidence_and_provider_failure_are_distinct():
    rows = evidence_rows()
    order = list(rows)

    class Gateway:
        def chat(self, *_args, **_kwargs):
            return '{"ranked_ids":[]}'

    assert rerank_evidence("材料中没有的事情", rows, order, Gateway())[0] == []

    class Unavailable:
        def chat(self, *_args, **_kwargs):
            raise ProviderError("timeout", retryable=True)

    selected, result = rerank_evidence("核对事实", rows, order, Unavailable())
    assert selected == order and result["status"] == "fallback"


def test_control_characters_cannot_break_the_payload_budget():
    rows = evidence_rows(16)
    for _, document in rows.values():
        document.display_name = "\x00" * 160

    class Gateway:
        def chat(self, messages, **_kwargs):
            assert len(messages[1]["content"]) <= MAX_INPUT_CHARS
            return '{"ranked_ids":[]}'

    assert rerank_evidence("\x00" * 2000, rows, list(rows), Gateway())[1]["status"] == "completed"
