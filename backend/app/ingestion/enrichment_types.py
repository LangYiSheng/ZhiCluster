"""Validated enrichment values, independent from storage and model execution."""

import json
import re
from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.ai.gateway import ProviderError


class SummaryResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    short_summary: str = Field(min_length=1, max_length=1500)
    detailed_summary: str = Field(min_length=1, max_length=8000)
    keywords: list[str] = Field(default_factory=list, max_length=20)
    main_topics: list[str] = Field(default_factory=list, max_length=12)


_SUMMARY_FIELDS = frozenset({"short_summary", "detailed_summary", "keywords", "main_topics"})
_SUMMARY_ERROR_TYPES = frozenset({
    "missing", "extra_forbidden", "model_type", "model_attributes_type", "dict_type", "list_type",
    "string_type", "string_too_short", "string_too_long", "too_short", "too_long",
})


def validate_summary(value) -> SummaryResult:
    """Expose schema diagnostics without copying provider content or extra keys."""
    try:
        return SummaryResult.model_validate(value)
    except ValidationError as error:
        details = set()
        for issue in error.errors(include_url=False, include_input=False, include_context=False):
            location = issue.get("loc", ())
            field_name = location[0] if location and location[0] in _SUMMARY_FIELDS else "summary"
            error_type = issue.get("type")
            safe_type = error_type if error_type in _SUMMARY_ERROR_TYPES else "invalid_value"
            details.add(f"{field_name}:{safe_type}")
        diagnostic = "; ".join(sorted(details)[:6]) or "summary:invalid_value"
        raise ProviderError(f"模型摘要字段验证失败，可重试该阶段（{diagnostic}）") from None


class ClassificationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    existing_folder_id: str | None = None
    proposed_folder_path: str | None = Field(default=None, max_length=500)
    existing_tag_ids: list[str] = Field(default_factory=list, max_length=6)
    new_tag_names: list[str] = Field(default_factory=list, max_length=6)
    short_summary: str = Field(default="", max_length=1500)
    reason: str = Field(max_length=2000)
    confidence_hint: str = Field(default="模型启发式建议，未经概率校准", max_length=500)


@dataclass
class EnrichmentOutcome:
    summary: SummaryResult | None = None
    classification: ClassificationResult | None = None
    errors: dict[str, ProviderError] = field(default_factory=dict)


def parse_json(text: str) -> dict:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", stripped)
    try:
        result = json.loads(stripped)
        if not isinstance(result, dict):
            raise ValueError("not object")
        return result
    except (ValueError, TypeError) as error:
        raise ProviderError("模型返回的结构化结果不合法，可重试该阶段") from error
