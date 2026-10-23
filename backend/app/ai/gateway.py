"""Independent OpenAI-compatible chat/embedding providers with bounded retries."""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections.abc import Iterator
from typing import Any

import httpx

from app.ai.concurrency import provider_limiter


class AIUnavailable(RuntimeError):
    pass


class ProviderError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class ModelCatalogError(ProviderError):
    def __init__(self, code: str, message: str, status: int = 502):
        super().__init__(message)
        self.code, self.status = code, status


class ModelGateway:
    MODEL_LIST_MAX_BYTES = 1024 * 1024
    MODEL_LIST_TIMEOUT_SECONDS = 15

    def __init__(self, settings: Any, *, transport: httpx.BaseTransport | None = None, workload: str = "interactive"):
        self.settings = settings
        self.transport = transport
        self._limiter = provider_limiter(settings)
        self._background = workload == "background"

    def _config(self, prefix: str) -> tuple[str, str, str, float, int]:
        return (
            str(getattr(self.settings, f"{prefix}_base_url", "")).rstrip("/"),
            self._secret(getattr(self.settings, f"{prefix}_api_key", "")),
            str(getattr(self.settings, f"{prefix}_model", "")),
            float(getattr(self.settings, f"{prefix}_timeout_seconds", 120)),
            min(4, max(0, int(getattr(self.settings, f"{prefix}_max_retries", 2)))),
        )

    @staticmethod
    def _secret(value: Any) -> str:
        return str(value.get_secret_value() if hasattr(value, "get_secret_value") else value or "")

    @property
    def llm_configured(self) -> bool:
        return all(self._config("llm")[:3])

    @property
    def embeddings_configured(self) -> bool:
        return all(self._config("embedding")[:3])

    @property
    def profile_fingerprint(self) -> str:
        base_url, _, model, _, _ = self._config("embedding")
        dimension = int(getattr(self.settings, "embedding_dimension", 0))
        return hashlib.sha256(f"{base_url}|{model}|{dimension}".encode()).hexdigest()

    def list_models(self, prefix: str) -> list[str]:
        """Read the provider catalog without selecting or probing a model.

        Catalogs do not have a standard capability field, so callers receive
        identifiers only. Never expose provider response bodies in errors.
        """
        if prefix not in {"llm", "embedding"}:
            raise ValueError("Invalid provider scope")
        base_url, key, _, configured_timeout, _ = self._config(prefix)
        if not base_url or not key:
            raise ModelCatalogError("model_list_unconfigured", "请先填写服务地址和 API 密钥", 422)
        timeout = min(configured_timeout, self.MODEL_LIST_TIMEOUT_SECONDS)
        started = time.monotonic()
        try:
            with httpx.Client(timeout=timeout, transport=self.transport, follow_redirects=False) as client:
                with client.stream("GET", f"{base_url}/models", headers={"Authorization": f"Bearer {key}"}) as response:
                    if response.status_code in {401, 403}:
                        raise ModelCatalogError("model_list_auth_failed", "模型列表获取失败：API 密钥无效或没有访问权限，请检查密钥与服务地址")
                    if response.status_code in {404, 405}:
                        raise ModelCatalogError("model_list_unsupported", "此服务未提供模型列表接口，请检查服务地址，或手动填写模型 ID")
                    if response.status_code == 429:
                        raise ModelCatalogError("model_list_rate_limited", "模型列表请求过于频繁，请稍后重试", 429)
                    if not response.is_success:
                        raise ModelCatalogError("model_list_provider_error", f"模型列表服务返回 HTTP {response.status_code}，请检查服务地址后重试")
                    payload = bytearray()
                    for chunk in response.iter_bytes():
                        if time.monotonic() - started > timeout:
                            raise ModelCatalogError("model_list_timeout", "获取模型列表超时，请检查服务地址或稍后重试", 504)
                        if len(payload) + len(chunk) > self.MODEL_LIST_MAX_BYTES:
                            raise ModelCatalogError("model_list_invalid_response", "模型列表响应过大，请联系服务提供方确认接口")
                        payload.extend(chunk)
            result = json.loads(payload)
        except httpx.TimeoutException as error:
            raise ModelCatalogError("model_list_timeout", "获取模型列表超时，请检查服务地址或稍后重试", 504) from error
        except httpx.RequestError as error:
            raise ModelCatalogError("model_list_network_error", "无法连接模型列表服务，请检查服务地址和网络", 502) from error
        except (ValueError, UnicodeError) as error:
            raise ModelCatalogError("model_list_invalid_response", "模型服务返回了无效的模型列表 JSON") from error
        if not isinstance(result, dict) or not isinstance(result.get("data"), list):
            raise ModelCatalogError("model_list_invalid_response", "模型列表格式不兼容，需要 data 数组和模型 id 字段")
        entries = result["data"]
        ids = set()
        for entry in entries:
            identifier = entry.get("id") if isinstance(entry, dict) else None
            if not isinstance(identifier, str):
                continue
            identifier = identifier.strip()
            if identifier and len(identifier) <= 512 and not any(ord(char) < 32 or ord(char) == 127 for char in identifier):
                ids.add(identifier)
        if entries and not ids:
            raise ModelCatalogError("model_list_invalid_response", "模型列表中没有有效的模型 ID，请联系服务提供方确认接口")
        return sorted(ids, key=lambda identifier: (identifier.casefold(), identifier))

    def _request(self, prefix: str, route: str, payload: dict) -> dict:
        base_url, key, model, timeout, retries = self._config(prefix)
        if not all((base_url, key, model)):
            raise AIUnavailable("需要配置模型服务" if prefix == "llm" else "需要配置 Embedding 模型服务")
        payload = {"model": model, **payload}
        with httpx.Client(timeout=timeout, transport=self.transport) as client:
            for attempt in range(retries + 1):
                try:
                    with self._limiter.slot(background=self._background):
                        response = client.post(f"{base_url}/{route}", json=payload, headers={"Authorization": f"Bearer {key}"})
                    retryable = response.status_code == 429 or response.status_code >= 500
                    if response.is_error:
                        if retryable and attempt < retries:
                            time.sleep(min(2 ** attempt, 8))
                            continue
                        raise ProviderError(f"{prefix} 服务返回 HTTP {response.status_code}；请检查模型名称、服务地址和权限", retryable=retryable)
                    result = response.json()
                    if not isinstance(result, dict):
                        raise ProviderError("模型服务返回了无效的数据结构")
                    return result
                except httpx.TransportError as error:
                    if attempt < retries:
                        time.sleep(min(2 ** attempt, 8))
                        continue
                    raise ProviderError(f"{prefix} 服务连接超时或网络不可达", retryable=True) from error
                except (ValueError, KeyError, TypeError) as error:
                    raise ProviderError("模型服务返回了无效 JSON") from error
        raise ProviderError("模型请求失败")

    def chat(self, messages: list[dict], *, json_mode: bool = False, max_tokens: int = 1200) -> str:
        payload: dict = {"messages": messages, "max_tokens": max_tokens, "temperature": 0.2}
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        result = self._request("llm", "chat/completions", payload)
        try:
            content = result["choices"][0]["message"]["content"]
            if not isinstance(content, str) or not content.strip():
                raise ValueError("empty content")
            return content
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise ProviderError("聊天模型没有返回可用文本") from error

    def stream_chat(self, messages: list[dict], *, max_tokens: int = 1800) -> Iterator[str]:
        base_url, key, model, timeout, retries = self._config("llm")
        if not self.llm_configured:
            raise AIUnavailable("需要配置模型服务")
        emitted = False
        with self._limiter.slot(background=self._background), httpx.Client(timeout=timeout, transport=self.transport) as client:
            for attempt in range(retries + 1):
                try:
                    with client.stream("POST", f"{base_url}/chat/completions", headers={"Authorization": f"Bearer {key}"}, json={"model": model, "messages": messages, "stream": True, "max_tokens": max_tokens}) as response:
                        if response.is_error:
                            retryable = response.status_code == 429 or response.status_code >= 500
                            if retryable and attempt < retries:
                                time.sleep(min(2 ** attempt, 8))
                                continue
                            raise ProviderError(f"聊天服务返回 HTTP {response.status_code}", retryable=retryable)
                        for line in response.iter_lines():
                            if not line.startswith("data:"):
                                continue
                            data = line[5:].strip()
                            if data == "[DONE]":
                                if not emitted:
                                    raise ProviderError("聊天模型返回了空的流式回答")
                                return
                            if not data:
                                continue
                            try:
                                chunk = json.loads(data)
                                if chunk.get("error"):
                                    raise ProviderError("模型服务在生成过程中返回错误")
                                choices = chunk.get("choices", [])
                                token = choices[0].get("delta", {}).get("content", "") if choices else ""
                            except (ValueError, TypeError, AttributeError) as error:
                                raise ProviderError("模型服务返回了无效流式数据") from error
                            if isinstance(token, str) and token:
                                emitted = True
                                yield token
                        if not emitted:
                            raise ProviderError("聊天模型没有返回可用的流式内容，请检查兼容接口是否支持 stream")
                        return
                except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as error:
                    if not emitted and attempt < retries:
                        time.sleep(min(2 ** attempt, 8))
                        continue
                    raise ProviderError("聊天流连接中断，已生成的内容已保留", retryable=True) from error

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        payload: dict = {"input": texts}
        # Some compatible providers reject the optional dimensions field. Validate
        # returned dimensions locally instead of assuming that parameter is supported.
        result = self._request("embedding", "embeddings", payload)
        try:
            data = sorted(result["data"], key=lambda item: item["index"])
            if len(data) != len(texts) or [item["index"] for item in data] != list(range(len(texts))):
                raise ValueError("embedding count/index mismatch")
            vectors = [item["embedding"] for item in data]
            dimension = int(getattr(self.settings, "embedding_dimension", 0)) or len(vectors[0])
            if dimension < 1:
                raise ValueError("empty embedding")
            for vector in vectors:
                if len(vector) != dimension or any(not isinstance(x, (int, float)) or not math.isfinite(x) for x in vector):
                    raise ValueError("dimension or numeric value mismatch")
                if not any(vector):
                    raise ValueError("zero vector cannot use cosine retrieval")
            return [[float(x) for x in vector] for vector in vectors]
        except (KeyError, TypeError, ValueError, IndexError) as error:
            raise ProviderError("Embedding 返回数量、维度或数值不合法；请校验 EMBEDDING_DIMENSION 并重建索引") from error

    def test_models(self, scope: str | None = None) -> dict:
        status: dict = {}

        def probe(name, callback):
            started = time.monotonic()
            try:
                value = callback()
            except (AIUnavailable, ProviderError) as error:
                value = {"ok": False, "message": str(error)}
            value["elapsed_ms"] = round((time.monotonic() - started) * 1000, 1)
            if name == "tool_calling":
                value.setdefault("supported", False)
            else:
                value["configured"] = self.llm_configured if name == "llm" else self.embeddings_configured
            status[name] = value

        def llm():
            self.chat([{"role": "user", "content": "Reply with OK."}], max_tokens=8)
            return {"ok": True, "message": "聊天模型连接成功"}

        def embedding():
            vectors = self.embed(["模型连接测试"])
            return {"ok": True, "dimension": len(vectors[0]), "message": "Embedding 连接与维度校验成功"}

        def tool_calling():
            result = self._request("llm", "chat/completions", {"messages": [{"role": "user", "content": "Call capability_probe with value=OK."}], "max_tokens": 64, "tools": [{"type": "function", "function": {"name": "capability_probe", "description": "Test tool calling support; no side effects.", "parameters": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}}}], "tool_choice": {"type": "function", "function": {"name": "capability_probe"}}})
            try:
                calls = result["choices"][0]["message"].get("tool_calls", [])
                supported = any(call.get("function", {}).get("name") == "capability_probe" for call in calls)
            except (KeyError, IndexError, TypeError, AttributeError) as error:
                raise ProviderError("模型服务返回了无效的工具调用数据") from error
            return {"ok": supported, "supported": supported, "message": "支持工具调用" if supported else "提供方未返回工具调用，Agent 不可用；知识问答仍可使用"}

        for name, callback in (("llm", llm), ("embedding", embedding), ("tool_calling", tool_calling)):
            if scope is None or scope == name:
                probe(name, callback)
        return status
