from typing import Literal

from pydantic import Field, model_validator

from app.schemas.requests import Input


class SuggestionDecision(Input):
    action: Literal["apply", "reject"]
    document_version: int = Field(ge=1)
    payload: dict | None = None


class SuggestionRefresh(Input):
    document_version: int = Field(ge=1)


class BatchSuggestionItem(Input):
    suggestion_id: str
    document_version: int = Field(ge=1)
    payload: dict | None = None


class BatchSuggestionDecision(Input):
    action: Literal["apply", "reject"]
    items: list[BatchSuggestionItem] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_items(self):
        if len({item.suggestion_id for item in self.items}) != len(self.items):
            raise ValueError("不能重复处理同一条建议")
        return self


class OrganizationRequest(Input):
    kb_id: str
    goal: str = Field(default="按资料主题整理目录和标签，优先复用已有分类，保留无需调整的文件", min_length=1, max_length=2000)
    document_ids: list[str] = Field(default_factory=list, max_length=50)
    mode: Literal["tags", "folders", "both"] = "both"
    cleanup_empty_folders: bool = True
