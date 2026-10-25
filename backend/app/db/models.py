from datetime import UTC, datetime
from uuid import uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow():
    return datetime.now(UTC)


def new_id():
    return str(uuid4())


class Base(DeclarativeBase):
    pass


class Entity:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class AppConfiguration(Base):
    __tablename__ = "app_configurations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    values: Mapped[dict] = mapped_column(JSON, nullable=False)
    secrets: Mapped[dict] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class StorageDeletion(Entity, Base):
    """Durable file cleanup after trash metadata has been committed."""
    __tablename__ = "storage_deletions"
    owner_id: Mapped[str] = mapped_column(String(36), index=True)
    storage_key: Mapped[str] = mapped_column(String(255), unique=True)
    attempts: Mapped[int] = mapped_column(default=0)
    error: Mapped[str | None] = mapped_column(Text)


class User(Entity, Base):
    __tablename__ = "users"
    email: Mapped[str] = mapped_column(String(255), unique=True)
    display_name: Mapped[str] = mapped_column(String(100))


class KnowledgeBase(Entity, Base):
    __tablename__ = "knowledge_bases"
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    icon: Mapped[str] = mapped_column(String(50), default="folder")
    color: Mapped[str] = mapped_column(String(7), default="#55a995")
    embedding_model: Mapped[str | None] = mapped_column(String(512))
    embedding_dimension: Mapped[int | None] = mapped_column(Integer)
    visibility: Mapped[str] = mapped_column(String(20), default="private")
    version: Mapped[int] = mapped_column(default=1)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class KnowledgeBaseMember(Entity, Base):
    __tablename__ = "knowledge_base_members"
    __table_args__ = (UniqueConstraint("kb_id", "user_id"), CheckConstraint("role IN ('owner','editor','viewer')", name="valid_member_role"))
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(20))


class Folder(Entity, Base):
    __tablename__ = "folders"
    __table_args__ = (
        UniqueConstraint("id", "kb_id", name="uq_folders_id_kb"),
        ForeignKeyConstraint(["parent_id", "kb_id"], ["folders.id", "folders.kb_id"], name="fk_folder_parent_same_kb"),
        CheckConstraint("parent_id IS NULL OR parent_id <> id", name="folder_not_self_parent"),
    )
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("folders.id"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    sort_order: Mapped[int] = mapped_column(default=0)
    version: Mapped[int] = mapped_column(default=1)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Document(Entity, Base):
    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("id", "kb_id", name="uq_documents_id_kb"),
        ForeignKeyConstraint(["folder_id", "kb_id"], ["folders.id", "folders.kb_id"], name="fk_document_folder_same_kb"),
    )
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    folder_id: Mapped[str | None] = mapped_column(ForeignKey("folders.id"), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    display_name: Mapped[str] = mapped_column(String(255))
    original_filename: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(150))
    ext: Mapped[str] = mapped_column(String(10), index=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    size_bytes: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str] = mapped_column(String(255), unique=True)
    parse_status: Mapped[str] = mapped_column(default="queued")
    index_status: Mapped[str] = mapped_column(default="queued")
    summary_status: Mapped[str] = mapped_column(default="queued")
    classification_status: Mapped[str] = mapped_column(default="queued")
    short_summary: Mapped[str] = mapped_column(Text, default="")
    detailed_summary: Mapped[str] = mapped_column(Text, default="")
    summary_metadata: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(default=1)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)


class DocumentSection(Entity, Base):
    __tablename__ = "document_sections"
    __table_args__ = (
        UniqueConstraint("id", "kb_id", name="uq_sections_id_kb"),
        ForeignKeyConstraint(["document_id", "kb_id"], ["documents.id", "documents.kb_id"], name="fk_section_document_same_kb"),
    )
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id"), index=True)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    parent_section_id: Mapped[str | None] = mapped_column(ForeignKey("document_sections.id"))
    heading: Mapped[str] = mapped_column(Text, default="")
    level: Mapped[int] = mapped_column(default=1)
    order: Mapped[int] = mapped_column(default=0)
    plain_text: Mapped[str] = mapped_column(Text)
    section_summary: Mapped[str] = mapped_column(Text, default="")
    anchors: Mapped[dict] = mapped_column(JSON, default=dict)


class DocumentChunk(Entity, Base):
    __tablename__ = "document_chunks"
    __table_args__ = (
        UniqueConstraint("document_id", "chunk_index"),
        UniqueConstraint("id", "kb_id", name="uq_chunks_id_kb"),
        ForeignKeyConstraint(["document_id", "kb_id"], ["documents.id", "documents.kb_id"], name="fk_chunk_document_same_kb"),
        ForeignKeyConstraint(["section_id", "kb_id"], ["document_sections.id", "document_sections.kb_id"], name="fk_chunk_section_same_kb"),
    )
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id"), index=True)
    section_id: Mapped[str] = mapped_column(ForeignKey("document_sections.id"), index=True)
    chunk_index: Mapped[int] = mapped_column()
    content: Mapped[str] = mapped_column(Text)
    token_count: Mapped[int] = mapped_column()
    anchors: Mapped[dict] = mapped_column(JSON, default=dict)
    source_start: Mapped[int] = mapped_column(default=0)
    source_end: Mapped[int] = mapped_column(default=0)


class EmbeddingProfile(Entity, Base):
    __tablename__ = "embedding_profiles"
    fingerprint: Mapped[str] = mapped_column(String(64), unique=True)
    model_name: Mapped[str] = mapped_column(String(512))
    dimension: Mapped[int] = mapped_column()
    status: Mapped[str] = mapped_column(default="active")


class ChunkEmbedding(Entity, Base):
    __tablename__ = "chunk_embeddings"
    __table_args__ = (
        UniqueConstraint("chunk_id", "profile_id"),
        ForeignKeyConstraint(["chunk_id", "kb_id"], ["document_chunks.id", "document_chunks.kb_id"], name="fk_embedding_chunk_same_kb"),
    )
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    chunk_id: Mapped[str] = mapped_column(ForeignKey("document_chunks.id"), index=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("embedding_profiles.id"), index=True)
    embedding: Mapped[list] = mapped_column(Vector().with_variant(JSON(), "sqlite"))


class Tag(Entity, Base):
    __tablename__ = "tags"
    __table_args__ = (UniqueConstraint("kb_id", "normalized_name"), UniqueConstraint("id", "kb_id", name="uq_tags_id_kb"))
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    normalized_name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str] = mapped_column(String(30), default="#6366f1")
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    version: Mapped[int] = mapped_column(default=1)


class DocumentTag(Base):
    __tablename__ = "document_tags"
    __table_args__ = (
        ForeignKeyConstraint(["document_id", "kb_id"], ["documents.id", "documents.kb_id"], name="fk_document_tag_document_same_kb"),
        ForeignKeyConstraint(["tag_id", "kb_id"], ["tags.id", "tags.kb_id"], name="fk_document_tag_tag_same_kb"),
    )
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id"), primary_key=True)
    tag_id: Mapped[str] = mapped_column(ForeignKey("tags.id"), primary_key=True)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)


class ClassificationSuggestion(Entity, Base):
    __tablename__ = "classification_suggestions"
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id"), unique=True)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(default="pending")
    document_version: Mapped[int] = mapped_column()
    model: Mapped[str] = mapped_column(String(512), default="")


class IngestionJob(Entity, Base):
    __tablename__ = "ingestion_jobs"
    document_id: Mapped[str | None] = mapped_column(ForeignKey("documents.id"), index=True)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    kind: Mapped[str] = mapped_column(default="ingest")
    status: Mapped[str] = mapped_column(default="queued", index=True)
    stage: Mapped[str] = mapped_column(default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0)
    attempts: Mapped[int] = mapped_column(default=0)
    lease_owner: Mapped[str | None] = mapped_column(String(100))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    error: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


class JobEvent(Entity, Base):
    __tablename__ = "job_events"
    sequence: Mapped[int] = mapped_column(Integer, index=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("ingestion_jobs.id"), index=True)
    type: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict] = mapped_column(JSON, default=dict)


class Conversation(Entity, Base):
    __tablename__ = "conversations"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    kb_id: Mapped[str | None] = mapped_column(String(36), index=True)
    title: Mapped[str] = mapped_column(String(160), default="新对话")
    scope: Mapped[dict] = mapped_column(JSON, default=dict)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Message(Entity, Base):
    __tablename__ = "messages"
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(default="completed")
    error: Mapped[str | None] = mapped_column(Text)
    retrieval: Mapped[dict] = mapped_column(JSON, default=dict)


class MessageCitation(Entity, Base):
    __tablename__ = "message_citations"
    message_id: Mapped[str] = mapped_column(ForeignKey("messages.id"), index=True)
    chunk_id: Mapped[str] = mapped_column(ForeignKey("document_chunks.id"))
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id"))
    ordinal: Mapped[int] = mapped_column()
    anchors: Mapped[dict] = mapped_column(JSON, default=dict)
    snippet: Mapped[str] = mapped_column(Text)


class ConversationEvent(Entity, Base):
    __tablename__ = "conversation_events"
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    sequence: Mapped[int] = mapped_column(index=True)
    type: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict] = mapped_column(JSON, default=dict)


class AgentRun(Entity, Base):
    __tablename__ = "agent_runs"
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    thread_id: Mapped[str] = mapped_column(String(36), unique=True)
    goal: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(default="queued")
    error: Mapped[str | None] = mapped_column(Text)


class AgentPlan(Entity, Base):
    __tablename__ = "agent_plans"
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), unique=True)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(default="pending")
    version: Mapped[int] = mapped_column(default=1)
    approved_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result: Mapped[dict] = mapped_column(JSON, default=dict)


class AgentPlanOperation(Entity, Base):
    __tablename__ = "agent_plan_operations"
    plan_id: Mapped[str] = mapped_column(ForeignKey("agent_plans.id"), index=True)
    operation_id: Mapped[str] = mapped_column(String(100))
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(default="pending")


class AgentEvent(Entity, Base):
    __tablename__ = "agent_events"
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), index=True)
    sequence: Mapped[int] = mapped_column(index=True)
    type: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict] = mapped_column(JSON, default=dict)


class AuditLog(Entity, Base):
    __tablename__ = "audit_logs"
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id"), index=True)
    run_id: Mapped[str | None] = mapped_column(String(36))
    plan_id: Mapped[str | None] = mapped_column(String(36))
    operation_id: Mapped[str | None] = mapped_column(String(100))
    action: Mapped[str] = mapped_column(String(80))
    entity_id: Mapped[str] = mapped_column(String(36))
    before: Mapped[dict] = mapped_column(JSON, default=dict)
    after: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[str] = mapped_column(default="success")


class UndoRecord(Entity, Base):
    __tablename__ = "undo_records"
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), index=True)
    entity_type: Mapped[str] = mapped_column(String(30))
    entity_id: Mapped[str] = mapped_column(String(36))
    before: Mapped[dict] = mapped_column(JSON)
    after_version: Mapped[int] = mapped_column()
    status: Mapped[str] = mapped_column(default="available")


Index("ix_documents_kb_hash", Document.kb_id, Document.sha256)
