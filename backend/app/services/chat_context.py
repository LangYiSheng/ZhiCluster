"""Bounded retrieval context and public execution steps for knowledge chat."""

import re
import time


def retrieval_query(question: str, previous: str | None = None) -> str:
    """Carry a topic only for explicit follow-ups, never every new question."""
    question = question.strip()
    follow_up = re.match(r"^(那[么个些它他她]?|这[个些种份]|它[们的]?|他[们的]?|她[们的]?|上述|前面|刚才|继续|还有呢|为什么呢|具体呢|再[说讲解释])", question)
    if previous and len(question) <= 100 and follow_up:
        return f"{previous[-300:]}\n追问：{question}"[-1200:]
    return question[-1200:]


def build_context(hits: list[dict], max_chars: int = 24000) -> tuple[str, list[dict]]:
    """Keep ranked, whole passages within a fixed model input budget."""
    selected, contexts, used = [], [], 0
    for hit in hits:
        body = str(hit.get("content") or hit.get("snippet") or "").strip()
        if not body:
            continue
        # Ingestion bounds chunks; an unexpectedly huge legacy chunk gets a
        # useful prefix without allowing it to consume the entire request.
        body = body[:6000]
        block = f"[S{len(selected) + 1}] {hit.get('document_name') or '参考文档'}\n{body}"
        size = len(block) + (2 if contexts else 0)
        if used + size > max_chars:
            continue
        contexts.append(block)
        selected.append(hit)
        used += size
    return "\n\n".join(contexts), selected


def conversation_context(history, max_chars: int = 6000) -> list[dict]:
    """Bound prior dialogue and avoid carrying old source ordinals into new evidence."""
    selected, used = [], 0
    for message in reversed(history):
        if message.status != "completed":
            continue
        content = message.content
        if message.role == "assistant":
            content = re.sub(r"\[S\d+\]", "", content)
        content = content[-2500:]
        if used + len(content) > max_chars:
            break
        selected.append({"role": message.role, "content": content})
        used += len(content)
    return list(reversed(selected))


class ExecutionSteps:
    """Persist actual public work stages, without model reasoning or fake %s."""

    def __init__(self):
        self.steps = []
        self.started = None
        self.activity_started = {}

    def advance(self, stage: str, label: str, **details) -> dict:
        self.finish(preserve_tools=True)
        self.started = time.monotonic()
        if stage == "tool_activity" and details.get("call_id"):
            call_id = details["call_id"]
            existing = next((step for step in self.steps if step["stage"] == stage and step.get("call_id") == call_id), None)
            if existing is not None:
                existing.update(label=label, **details)
                if details.get("status") != "running":
                    existing["elapsed_ms"] = round((time.monotonic() - self.activity_started[call_id]) * 1000)
                return existing
            self.activity_started[call_id] = self.started
        step = {"stage": stage, "label": label, "status": "running", **details}
        self.steps.append(step)
        return step

    def finish(self, status: str = "completed", *, preserve_tools=False):
        if self.steps and self.steps[-1]["status"] == "running" and self.steps[-1]["stage"] != "tool_activity":
            self.steps[-1]["status"] = status
            self.steps[-1]["elapsed_ms"] = round((time.monotonic() - self.started) * 1000)
        if not preserve_tools:
            for step in self.steps:
                if step["stage"] == "tool_activity" and step["status"] == "running":
                    step["status"] = status
                    step["elapsed_ms"] = round((time.monotonic() - self.activity_started[step["call_id"]]) * 1000)

    def snapshot(self) -> list[dict]:
        return [dict(step) for step in self.steps]
