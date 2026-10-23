"""Failure diagnostics preserve phase and never expose provider request data."""

import httpx
import pytest
from test_ai_gateway import settings

from app.ai.gateway import ModelGateway, ProviderError


@pytest.mark.parametrize(("error_type", "code", "label"), [
    (httpx.ReadTimeout, "read_timeout", "等待聊天模型响应超时"),
    (httpx.ConnectTimeout, "connect_timeout", "连接聊天模型超时"),
    (httpx.WriteTimeout, "write_timeout", "发送请求超时"),
    (httpx.PoolTimeout, "pool_timeout", "连接池超时"),
    (httpx.ConnectError, "connect_error", "无法建立聊天模型连接"),
    (httpx.ReadError, "network_error", "传输过程中中断"),
    (httpx.RemoteProtocolError, "protocol_error", "协议异常"),
    (httpx.ProxyError, "proxy_error", "代理"),
])
def test_phase_specific_errors_are_safe_and_keep_retryability(error_type, code, label):
    def respond(request):
        assert request.extensions["timeout"]["read"] == 120
        raise error_type("private response: chat-secret https://private.invalid?key=secret", request=request)

    gateway = ModelGateway(settings(llm_timeout_seconds=120), transport=httpx.MockTransport(respond))
    with pytest.raises(ProviderError) as caught:
        gateway.chat([{"role": "user", "content": "source"}])
    assert caught.value.code == code and caught.value.retryable
    assert label in str(caught.value)
    assert "secret" not in str(caught.value) and "private" not in str(caught.value)


def test_embedding_timeout_names_the_correct_service():
    def respond(request):
        raise httpx.ReadTimeout("sensitive", request=request)

    with pytest.raises(ProviderError, match="等待向量模型响应超时"):
        ModelGateway(settings(), transport=httpx.MockTransport(respond)).embed(["source"])


@pytest.mark.parametrize("emitted", [False, True])
def test_stream_failure_distinguishes_before_and_after_content(emitted):
    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            if emitted:
                yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            raise httpx.ReadTimeout("private key")

    gateway = ModelGateway(settings(), transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=Stream())))
    generator = gateway.stream_chat([{"role": "user", "content": "source"}])
    if emitted:
        assert next(generator) == "partial"
    with pytest.raises(ProviderError) as caught:
        list(generator)
    assert caught.value.code == "read_timeout"
    assert ("已生成的内容已保留" in str(caught.value)) is emitted
    assert "private" not in str(caught.value)


def test_truncated_json_is_not_mislabeled_as_a_schema_or_network_failure():
    gateway = ModelGateway(settings(), transport=httpx.MockTransport(lambda _: httpx.Response(200, json={
        "choices": [{"message": {"content": '{"unfinished":'}, "finish_reason": "length"}],
    })))
    with pytest.raises(ProviderError) as caught:
        gateway.chat([{"role": "user", "content": "source"}], json_mode=True)
    assert caught.value.code == "output_truncated" and not caught.value.retryable
    assert "长度上限" in str(caught.value)


@pytest.mark.parametrize("choice", [None, 1, "invalid"])
def test_invalid_choice_remains_a_safe_provider_error(choice):
    gateway = ModelGateway(settings(), transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"choices": [choice]})))
    with pytest.raises(ProviderError, match="没有返回可用文本"):
        gateway.chat([{"role": "user", "content": "source"}])
