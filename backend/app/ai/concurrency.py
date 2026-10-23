"""Process-wide provider admission, shared by independent gateway instances."""

from __future__ import annotations

import hashlib
import threading
import weakref
from contextlib import contextmanager
from typing import Any


class ModelCallLimiter:
    def __init__(self, limit: int):
        self.limit = max(1, limit)
        self._condition = threading.Condition()
        self._active = self._background = self._waiting_interactive = 0

    @contextmanager
    def slot(self, *, background: bool = False):
        # One provider slot remains available to interactive work when possible.
        background_limit = max(1, self.limit - 1)
        with self._condition:
            if not background:
                self._waiting_interactive += 1
            try:
                self._condition.wait_for(lambda: self._active < self.limit and (
                    not background or (self._background < background_limit and not self._waiting_interactive)
                ))
                self._active += 1
                self._background += int(background)
            finally:
                if not background:
                    self._waiting_interactive -= 1
        try:
            yield
        finally:
            with self._condition:
                self._active -= 1
                self._background -= int(background)
                self._condition.notify_all()


_registry_lock = threading.Lock()
_registry: weakref.WeakValueDictionary[tuple, ModelCallLimiter] = weakref.WeakValueDictionary()


def provider_limiter(settings: Any) -> ModelCallLimiter:
    def provider(prefix: str) -> tuple[str, str]:
        value = getattr(settings, f"{prefix}_api_key", "")
        secret = value.get_secret_value() if hasattr(value, "get_secret_value") else str(value or "")
        return (str(getattr(settings, f"{prefix}_base_url", "")).rstrip("/"), hashlib.sha256(secret.encode()).hexdigest())

    limit = max(1, int(getattr(settings, "max_concurrent_model_calls", 3)))
    key = (*provider("llm"), *provider("embedding"), limit)
    # A changed configuration gets a new limiter. Existing requests keep and
    # release their original snapshot; stale credentials are not retained.
    with _registry_lock:
        limiter = _registry.get(key)
        if limiter is None:
            limiter = ModelCallLimiter(limit)
            _registry[key] = limiter
        return limiter
