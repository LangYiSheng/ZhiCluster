from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class EntityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime
    updated_at: datetime


class KnowledgeBaseOut(EntityOut):
    owner_id: str
    name: str
    description: str
    icon: str
    color: str
    embedding_model: str | None
    embedding_dimension: int | None
    visibility: str
    version: int
    deleted_at: datetime | None


class FolderOut(EntityOut):
    kb_id: str
    parent_id: str | None
    name: str
    sort_order: int
    version: int
    deleted_at: datetime | None


class TagOut(EntityOut):
    kb_id: str
    name: str
    normalized_name: str
    color: str
    aliases: list[str]
    version: int


class DocumentOut(EntityOut):
    kb_id: str
    folder_id: str | None
    owner_id: str
    display_name: str
    original_filename: str
    mime_type: str
    preview_type: Literal["pdf", "text"] | None = None
    ext: str
    sha256: str
    size_bytes: int
    parse_status: str
    index_status: str
    summary_status: str
    classification_status: str
    short_summary: str
    detailed_summary: str
    summary_metadata: dict
    error: str | None
    version: int
    deleted_at: datetime | None
    tag_ids: list[str] = Field(default_factory=list)


class DocumentPage(BaseModel):
    items: list[DocumentOut]
    total: int
    page: int
    page_size: int


class SectionOut(EntityOut):
    kb_id: str
    document_id: str
    parent_section_id: str | None
    heading: str
    level: int
    order: int
    plain_text: str
    section_summary: str
    anchors: dict[str, int | str]


class JobOut(EntityOut):
    kb_id: str
    document_id: str | None
    kind: str
    status: str
    stage: str
    progress: float
    attempts: int
    error: str | None
    next_attempt_at: datetime | None
    document_name: str | None = None
    document_available: bool = True


class JobCounts(BaseModel):
    all: int
    attention: int
    active: int
    completed: int


class JobPage(BaseModel):
    items: list[JobOut]
    total: int
    page: int
    page_size: int
    counts: JobCounts


class SearchItem(BaseModel):
    document_id: str
    document_name: str
    kb_id: str
    kb_name: str | None = None
    ext: str | None = None
    chunk_id: str
    section_id: str
    snippet: str
    content: str
    anchors: dict[str, int | str]
    score: float


class SearchOut(BaseModel):
    items: list[SearchItem]
    total: int
    mode: str
    notice: str
    elapsed_ms: float
    kb_ids: list[str]
    reranking: dict = Field(default_factory=dict)


class ConversationOut(EntityOut):
    user_id: str
    kb_id: str | None
    title: str
    scope: dict
    deleted_at: datetime | None
