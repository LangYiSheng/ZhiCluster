from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KBCreate(Input):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=4000)


class KBUpdate(Input):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    version: int | None = None


class FolderCreate(Input):
    name: str = Field(min_length=1, max_length=160)
    parent_id: str | None = None


class FolderUpdate(Input):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    parent_id: str | None = None
    version: int | None = None


class TagCreate(Input):
    name: str = Field(min_length=1, max_length=100)
    color: str = Field(default="#6366f1", pattern=r"^#[0-9a-fA-F]{6}$")
    aliases: list[str] = Field(default_factory=list, max_length=30)


class TagUpdate(Input):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    aliases: list[str] | None = None
    version: int | None = None


class DocumentUpdate(Input):
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    folder_id: str | None = None
    tag_ids: list[str] | None = None
    version: int | None = None


class Batch(Input):
    kb_id: str
    document_ids: list[str] = Field(min_length=1, max_length=200)
    action: Literal["move", "tags", "trash", "restore"]
    folder_id: str | None = None
    tag_ids: list[str] = Field(default_factory=list)
    tag_mode: Literal["set", "add", "remove"] = "set"


class Search(Input):
    query: str = Field(min_length=1, max_length=2000)
    kb_ids: list[str] = Field(default_factory=list)
    folder_ids: list[str] = Field(default_factory=list)
    include_descendants: bool = True
    tag_ids: list[str] = Field(default_factory=list)
    tag_match: Literal["all", "any"] = "all"
    document_ids: list[str] = Field(default_factory=list)
    exts: list[str] = Field(default_factory=list)
    date_from: str | None = None
    date_to: str | None = None
    mode: Literal["keyword", "hybrid"] = "hybrid"
    rerank: bool = False
    limit: int = Field(default=30, ge=1, le=100)
    offset: int = Field(default=0, ge=0, le=10000)


class ConversationCreate(Input):
    title: str = Field(default="新对话", min_length=1, max_length=160)
    scope: dict = Field(default_factory=dict)


class ConversationUpdate(Input):
    title: str = Field(min_length=1, max_length=160)


class ChatMessage(Input):
    content: str = Field(min_length=1, max_length=16000)
    retrieval_mode: Literal["direct", "model"] = "direct"


class SuggestionAction(Input):
    action: Literal["apply", "reject"]
    payload: dict | None = None


class Rebuild(Input):
    kb_id: str
