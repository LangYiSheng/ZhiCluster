import json
from types import SimpleNamespace

import httpx
import pytest

from app.ai.gateway import AIUnavailable, ModelGateway, ProviderError
from app.ingestion.chunking import count_tokens
from app.ingestion.enrichment import classify_document, summarize_sections


def settings(**overrides):
    values = dict(llm_base_url="https://chat.invalid/v1", llm_api_key="chat-secret", llm_model="chat-model", llm_max_retries=0, embedding_base_url="https://embedding.invalid/v1", embedding_api_key="embed-secret", embedding_model="embed-model", embedding_dimension=3, embedding_max_retries=0, summary_input_tokens=900, summary_max_calls=80)
    return SimpleNamespace(**{**values, **overrides})


def test_chat_embedding_use_independent_provider_and_keys():
    calls = []

    def respond(request):
        calls.append(request)
        body = json.loads(request.content)
        if request.url.host == "chat.invalid":
            assert body["model"] == "chat-model"
            assert request.headers["authorization"] == "Bearer chat-secret"
            return httpx.Response(200, json={"choices": [{"message": {"content": "真实提供方文本"}}]})
        assert body["model"] == "embed-model"
        assert request.headers["authorization"] == "Bearer embed-secret"
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1, 0.2, 0.3]}]})

    gateway = ModelGateway(settings(), transport=httpx.MockTransport(respond))
    assert gateway.chat([{"role": "user", "content": "hello"}]) == "真实提供方文本"
    assert gateway.embed(["text"]) == [[0.1, 0.2, 0.3]]
    assert len(calls) == 2
    assert "secret" not in gateway.profile_fingerprint
    assert gateway.profile_fingerprint != ModelGateway(settings(embedding_dimension=4)).profile_fingerprint


@pytest.mark.parametrize("vectors", [[[1, 2]], [[0, 0, 0]], [[1, float("nan"), 2]]])
def test_embedding_dimension_and_values_are_validated(vectors):
    gateway = ModelGateway(settings(), transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"data": [{"index": i, "embedding": vector} for i, vector in enumerate(vectors)]})))
    with pytest.raises(ProviderError, match="维度或数值|无效 JSON"):
        gateway.embed(["test"])


def test_unconfigured_does_not_fabricate_results():
    gateway = ModelGateway(settings(llm_api_key="", embedding_api_key=""))
    with pytest.raises(AIUnavailable):
        gateway.chat([{"role": "user", "content": "question"}])
    with pytest.raises(AIUnavailable):
        gateway.embed(["text"])
    assert gateway.test_models()["llm"]["ok"] is False


def test_finite_retry_and_no_sensitive_error_body(monkeypatch):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(429, json={"error": "chat-secret"})

    monkeypatch.setattr("app.ai.gateway.time.sleep", lambda _: None)
    gateway = ModelGateway(settings(llm_max_retries=2), transport=httpx.MockTransport(respond))
    with pytest.raises(ProviderError) as error:
        gateway.chat([{"role": "user", "content": "question"}])
    assert len(calls) == 3
    assert "secret" not in str(error.value)
    assert error.value.retryable


def test_real_sse_protocol_tokens():
    content = 'data: {"choices":[{"delta":{"content":"知识"}}]}\n\ndata: {"choices":[{"delta":{"content":"证据"}}]}\n\ndata: [DONE]\n\n'
    gateway = ModelGateway(settings(), transport=httpx.MockTransport(lambda _: httpx.Response(200, text=content)))
    assert list(gateway.stream_chat([{"role": "user", "content": "question"}])) == ["知识", "证据"]


@pytest.mark.parametrize("content", ["data: [DONE]\n\n", '{"choices":[{"message":{"content":"not a stream"}}]}'])
def test_empty_or_unsupported_stream_cannot_finish_as_success(content):
    gateway = ModelGateway(settings(), transport=httpx.MockTransport(lambda _: httpx.Response(200, text=content)))
    with pytest.raises(ProviderError, match="空的流式|可用的流式"):
        list(gateway.stream_chat([{"role": "user", "content": "question"}]))


def test_stream_is_not_retried_after_first_token():
    calls = []

    class BrokenStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            raise httpx.ReadError("network disconnected")

    def respond(request):
        calls.append(request)
        return httpx.Response(200, stream=BrokenStream())

    gateway = ModelGateway(settings(llm_max_retries=2), transport=httpx.MockTransport(respond))
    stream = gateway.stream_chat([{"role": "user", "content": "question"}])
    assert next(stream) == "partial"
    with pytest.raises(ProviderError, match="已生成的内容已保留"):
        next(stream)
    assert len(calls) == 1


def test_tree_summary_requests_are_bounded_and_budgeted():
    class FakeGateway:
        def __init__(self):
            self.inputs = []

        def chat(self, messages, *, json_mode=False, max_tokens=0):
            self.inputs.append(messages[-1]["content"])
            if json_mode:
                return json.dumps({"short_summary": "短摘要", "detailed_summary": "详细摘要", "keywords": ["研究"], "main_topics": ["知识库"]})
            return "保留核心研究证据。"

    gateway = FakeGateway()
    saved = []
    sections = [SimpleNamespace(plain_text="这是很长的研究材料。" * 200, section_summary="") for _ in range(3)]
    result = summarize_sections(sections, gateway, settings(), lambda i, summary: saved.append((i, summary)))
    assert result.short_summary == "短摘要"
    assert len(saved) == 3
    assert len(gateway.inputs) > 4
    assert all(count_tokens(text) < 900 for text in gateway.inputs)
    with pytest.raises(ProviderError, match="调用预算"):
        summarize_sections(sections, FakeGateway(), settings(summary_max_calls=1))


def test_classification_reuses_normalized_aliases_and_rejects_foreign_ids():
    class FakeGateway:
        def chat(self, *args, **kwargs):
            return json.dumps({"existing_folder_id": "folder-1", "proposed_folder_path": "不要创建", "existing_tag_ids": [], "new_tag_names": [" ＬＬＭ ", "检索增强"], "short_summary": "摘要", "reason": "匹配已有别名", "confidence_hint": "启发式建议"})

    result = classify_document("论文", "摘要", [{"id": "folder-1", "name": "AI"}], [{"id": "tag-1", "name": "大语言模型", "aliases": ["LLM"]}], FakeGateway())
    assert result.existing_tag_ids == ["tag-1"]
    assert result.new_tag_names == ["检索增强"]
    assert result.proposed_folder_path is None
    legacy = classify_document("论文", "摘要", [], [], FakeGateway())
    assert legacy.existing_folder_id is None and legacy.proposed_folder_path is None

    class InvalidTagGateway:
        def chat(self, *args, **kwargs):
            return json.dumps({"existing_tag_ids": ["foreign-tag"], "reason": "非法跨库标签"})

    with pytest.raises(ProviderError, match="跨知识库"):
        classify_document("论文", "摘要", [], [], InvalidTagGateway())
