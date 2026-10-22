"""Independent OpenAI-compatible chat/embedding providers with bounded retries."""

from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from collections.abc import Iterator
from typing import Any

import httpx


class AIUnavailable(RuntimeError):
    pass


class ProviderError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class ModelGateway:
    def __init__(self, settings: Any, *, transport: httpx.BaseTransport | None = None):
        self.settings = settings
        self.transport = transport
        self._semaphore = threading.BoundedSemaphore(max(1, int(getattr(settings, "max_concurrent_model_calls", 3))))

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

    def _request(self, prefix: str, route: str, payload: dict) -> dict:
        base_url, key, model, timeout, retries = self._config(prefix)
        if not all((base_url, key, model)):
            raise AIUnavailable("需要配置模型服务" if prefix == "llm" else "需要配置 Embedding 模型服务")
        payload = {"model": model, **payload}
        with self._semaphore, httpx.Client(timeout=timeout, transport=self.transport) as client:
            for attempt in range(retries + 1):
                try:
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
                except (httpx.TimeoutException, httpx.NetworkError) as error:
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
        with self._semaphore, httpx.Client(timeout=timeout, transport=self.transport) as client:
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

    def test_models(self) -> dict:
        status: dict = {}
        try:
            self.chat([{"role": "user", "content": "Reply with OK."}], max_tokens=8)
            status["llm"] = {"configured": True, "ok": True, "message": "聊天模型连接成功"}
        except (AIUnavailable, ProviderError) as error:
            status["llm"] = {"configured": self.llm_configured, "ok": False, "message": str(error)}
        try:
            vectors = self.embed(["模型连接测试"])
            status["embedding"] = {"configured": True, "ok": True, "dimension": len(vectors[0]), "message": "Embedding 连接与维度校验成功"}
        except (AIUnavailable, ProviderError) as error:
            status["embedding"] = {"configured": self.embeddings_configured, "ok": False, "message": str(error)}
        try:
            result = self._request("llm", "chat/completions", {"messages": [{"role": "user", "content": "Call capability_probe with value=OK."}], "max_tokens": 64, "tools": [{"type": "function", "function": {"name": "capability_probe", "description": "Test tool calling support; no side effects.", "parameters": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}}}], "tool_choice": {"type": "function", "function": {"name": "capability_probe"}}})
            calls = result.get("choices", [{}])[0].get("message", {}).get("tool_calls", [])
            supported = any(call.get("function", {}).get("name") == "capability_probe" for call in calls)
            status["tool_calling"] = {"ok": supported, "supported": supported, "message": "支持工具调用" if supported else "提供方未返回工具调用，Agent 不可用；知识问答仍可使用"}
        except (AIUnavailable, ProviderError, IndexError) as error:
            status["tool_calling"] = {"ok": False, "supported": False, "message": str(error)}
        return status
