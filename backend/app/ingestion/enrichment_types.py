"""Validated enrichment values, independent from storage and model execution."""

import json
import re
from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict, Field

from app.ai.gateway import ProviderError


class SummaryResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    short_summary: str = Field(min_length=1, max_length=1500)
    detailed_summary: str = Field(min_length=1, max_length=8000)
    keywords: list[str] = Field(default_factory=list, max_length=20)
    main_topics: list[str] = Field(default_factory=list, max_length=12)


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
