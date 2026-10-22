from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select

from app.ai.gateway import AIUnavailable, ModelGateway, ProviderError
from app.core.config import get_settings
from app.db.models import (
    ChunkEmbedding,
    ClassificationSuggestion,
    Document,
    DocumentChunk,
    DocumentSection,
    EmbeddingProfile,
    Folder,
    IngestionJob,
    KnowledgeBase,
    Tag,
    new_id,
    utcnow,
)
from app.db.session import SessionLocal
from app.ingestion.chunking import chunk_sections
from app.ingestion.enrichment import classify_document, summarize_sections
from app.ingestion.parsers import ParseError, parse_document
from app.services.runtime_config import get_runtime_settings
from app.worker.queue import emit


class JobCancelled(RuntimeError):
    pass


def _safe_path(root: Path, key: str) -> Path:
    root = root.resolve()
    path = (root / key).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ParseError("原始文件存储路径无效")
    return path


def process_ingestion_job(job_id: str, session_factory=SessionLocal, settings: Any = None, gateway: ModelGateway | None = None, owner: str | None = None) -> None:
    with session_factory() as db:
        settings = settings or get_runtime_settings(db, get_settings())
        gateway = gateway or ModelGateway(settings)
        job = db.get(IngestionJob, job_id)
        if job is None or job.status in {"cancelled", "completed"}:
            return
        if owner and (job.lease_owner != owner or job.status != "running"):
            return
        document = db.get(Document, job.document_id)
        kb = db.get(KnowledgeBase, job.kb_id)
        if document is None or document.deleted_at or kb is None or kb.deleted_at:
            job.status = "cancelled"
            job.error = "文档或知识库已删除"
            db.commit()
            return

        def check_active() -> None:
            db.refresh(job)
            db.refresh(document)
            if job.status == "cancelled" or document.deleted_at or (owner and job.lease_owner != owner):
                raise JobCancelled("任务已取消或租约已移交")

        def stage(name: str, progress: float) -> None:
            check_active()
            job.stage = name
            job.progress = progress
            emit(db, job, "progress", {"stage": name, "progress": progress, "document_id": document.id})
            db.commit()

        retryable = False
        errors = []
        try:
            parsed = None
            if document.parse_status != "ready":
                stage("parsing", 5)
                parsed = parse_document(_safe_path(Path(settings.upload_root), document.storage_key), document.ext)
                # Rebuild only on parse retry, never for folder/tag/name changes.
                chunk_ids = select(DocumentChunk.id).where(DocumentChunk.document_id == document.id)
                db.execute(delete(ChunkEmbedding).where(ChunkEmbedding.chunk_id.in_(chunk_ids)))
                db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == document.id))
                db.execute(delete(DocumentSection).where(DocumentSection.document_id == document.id))
                section_ids = []
                for index, section in enumerate(parsed.sections):
                    section_id = new_id()
                    section_ids.append(section_id)
                    db.add(DocumentSection(id=section_id, document_id=document.id, kb_id=document.kb_id, parent_section_id=section_ids[section.parent_index] if section.parent_index is not None else None, heading=section.heading, level=section.level, order=index, plain_text=section.text, anchors={**section.anchor, "source_start": section.source_start, "source_end": section.source_end}))
                    db.flush()
                document.parse_status = "ready"
                document.error = None
                db.commit()
                stage("chunking", 20)
                for chunk in chunk_sections(parsed.sections, int(settings.chunk_size_tokens), int(settings.chunk_overlap_tokens)):
                    db.add(DocumentChunk(kb_id=document.kb_id, document_id=document.id, section_id=section_ids[chunk.section_index], chunk_index=chunk.chunk_index, content=chunk.content, token_count=chunk.token_count, anchors=chunk.anchor, source_start=chunk.source_start, source_end=chunk.source_end))
                db.commit()
            sections = list(db.scalars(select(DocumentSection).where(DocumentSection.document_id == document.id).order_by(DocumentSection.order)))
            chunks = list(db.scalars(select(DocumentChunk).where(DocumentChunk.document_id == document.id).order_by(DocumentChunk.chunk_index)))
            if not chunks:
                # A crash between the durable parse and chunk commits is recoverable.
                from app.ingestion.parsers import ParsedSection

                rebuilt = []
                source_offset = 0
                for section in sections:
                    source_start = section.anchors.get("source_start", source_offset)
                    source_end = section.anchors.get("source_end", source_start + len(section.plain_text))
                    anchors = {key: value for key, value in section.anchors.items() if key not in {"source_start", "source_end"}}
                    rebuilt.append(ParsedSection(section.heading, section.level, section.plain_text, anchors, source_start, source_end))
                    source_offset += len(section.plain_text) + 1
                for chunk in chunk_sections(rebuilt, int(settings.chunk_size_tokens), int(settings.chunk_overlap_tokens)):
                    db.add(DocumentChunk(kb_id=document.kb_id, document_id=document.id, section_id=sections[chunk.section_index].id, chunk_index=chunk.chunk_index, content=chunk.content, token_count=chunk.token_count, anchors=chunk.anchor, source_start=chunk.source_start, source_end=chunk.source_end))
                db.commit()
                chunks = list(db.scalars(select(DocumentChunk).where(DocumentChunk.document_id == document.id).order_by(DocumentChunk.chunk_index)))

            stage("embedding", 30)
            if not gateway.embeddings_configured:
                document.index_status = "unconfigured"
                db.commit()
            else:
                try:
                    profile = db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.fingerprint == gateway.profile_fingerprint))
                    if profile is None:
                        profile = EmbeddingProfile(fingerprint=gateway.profile_fingerprint, model_name=settings.embedding_model, dimension=int(settings.embedding_dimension), status="active")
                        db.add(profile)
                        db.flush()
                    if profile.dimension != int(settings.embedding_dimension):
                        raise ProviderError("Embedding profile 维度不兼容，需重新向量化")
                    existing = set(db.scalars(select(ChunkEmbedding.chunk_id).where(ChunkEmbedding.profile_id == profile.id, ChunkEmbedding.kb_id == document.kb_id, ChunkEmbedding.chunk_id.in_(select(DocumentChunk.id).where(DocumentChunk.document_id == document.id)))))
                    missing = [chunk for chunk in chunks if chunk.id not in existing]
                    batch_size = max(1, int(settings.embedding_batch_size))
                    for start in range(0, len(missing), batch_size):
                        check_active()
                        batch = missing[start:start + batch_size]
                        vectors = gateway.embed([chunk.content for chunk in batch])
                        check_active()
                        for chunk, vector in zip(batch, vectors, strict=True):
                            if len(vector) != profile.dimension:
                                raise ProviderError("Embedding 实际维度与 profile 不一致")
                            db.add(ChunkEmbedding(kb_id=document.kb_id, chunk_id=chunk.id, profile_id=profile.id, embedding=vector))
                        job.progress = 30 + 25 * (start + len(batch)) / max(1, len(missing))
                        emit(db, job, "progress", {"stage": "embedding", "completed_chunks": len(existing.intersection({chunk.id for chunk in chunks})) + start + len(batch), "total_chunks": len(chunks), "progress": job.progress})
                        db.commit()
                    document.index_status = "ready"
                    db.commit()
                except (AIUnavailable, ProviderError) as error:
                    document.index_status = "failed"
                    errors.append(str(error))
                    retryable |= getattr(error, "retryable", False)
                    db.commit()

            if job.kind == "reindex":
                check_active()
                job.status = "partial_ready" if errors or document.index_status != "ready" else "completed"
                job.stage = "completed"
                job.progress = 100
                job.error = "; ".join(errors) if errors else "需要配置 Embedding 模型服务" if document.index_status != "ready" else None
                job.lease_owner = None
                job.lease_until = None
                emit(db, job, "completed", {"status": job.status, "document_id": document.id, "message": job.error})
                db.commit()
                return

            stage("summarizing", 60)
            if not gateway.llm_configured:
                document.summary_status = "unconfigured"
                document.classification_status = "unconfigured"
                db.commit()
            else:
                if document.summary_status != "ready":
                    try:
                        def save_section(index: int, summary: str) -> None:
                            check_active()
                            sections[index].section_summary = summary
                            db.commit()

                        summary = summarize_sections(sections, gateway, settings, save_section)
                        check_active()
                        document.short_summary = summary.short_summary
                        document.detailed_summary = summary.detailed_summary
                        document.summary_metadata = {"keywords": summary.keywords, "main_topics": summary.main_topics}
                        document.summary_status = "ready"
                        db.commit()
                    except (AIUnavailable, ProviderError) as error:
                        document.summary_status = "failed"
                        errors.append(str(error))
                        retryable |= getattr(error, "retryable", False)
                        db.commit()
                stage("classifying", 85)
                if document.classification_status != "ready":
                    try:
                        folders = [{"id": folder.id, "name": folder.name, "parent_id": folder.parent_id} for folder in db.scalars(select(Folder).where(Folder.kb_id == document.kb_id, Folder.deleted_at.is_(None)))]
                        tags = [{"id": tag.id, "name": tag.name, "aliases": tag.aliases} for tag in db.scalars(select(Tag).where(Tag.kb_id == document.kb_id))]
                        source_summary = document.detailed_summary or "\n".join(section.section_summary for section in sections if section.section_summary) or "\n".join(section.plain_text for section in sections[:3])
                        base_version = document.version
                        suggestion = classify_document(document.display_name, source_summary, folders, tags, gateway, int(settings.summary_input_tokens))
                        check_active()
                        db.refresh(document)
                        current = db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == document.id))
                        if current is None:
                            current = ClassificationSuggestion(document_id=document.id, kb_id=document.kb_id, document_version=base_version)
                            db.add(current)
                        current.payload = suggestion.model_dump()
                        current.document_version = base_version
                        current.model = settings.llm_model
                        current.status = "pending"
                        document.classification_status = "ready"
                        db.commit()
                    except (AIUnavailable, ProviderError) as error:
                        document.classification_status = "failed"
                        errors.append(str(error))
                        retryable |= getattr(error, "retryable", False)
                        db.commit()
            check_active()
            has_unconfigured = any(status == "unconfigured" for status in (document.index_status, document.summary_status, document.classification_status))
            job.error = "; ".join(errors) if errors else "需要配置模型服务；解析与关键词搜索已就绪" if has_unconfigured else None
            document.error = "; ".join(errors) if errors else None
            if retryable and job.attempts < int(settings.max_ingestion_attempts):
                job.status = "retry_wait"
                job.next_attempt_at = utcnow() + timedelta(seconds=min(60, 2 ** max(1, job.attempts)))
            else:
                job.status = "partial_ready" if errors or has_unconfigured else "completed"
            job.stage = "completed"
            job.progress = 100
            job.lease_owner = None
            job.lease_until = None
            emit(db, job, "completed", {"status": job.status, "document_id": document.id, "message": job.error, "parse_status": document.parse_status})
            db.commit()
        except JobCancelled:
            db.rollback()
        except Exception as error:
            db.rollback()
            job = db.get(IngestionJob, job_id)
            document = db.get(Document, job.document_id)
            # Never include file bytes/provider response bodies/credentials in errors.
            message = str(error) if isinstance(error, ParseError) else f"入库阶段 {job.stage} 失败（{type(error).__name__}），请查看服务日志并重试"
            if document.parse_status != "ready":
                document.parse_status = "failed"
            document.error = message
            job.error = message
            if not isinstance(error, ParseError) and job.attempts < int(settings.max_ingestion_attempts):
                job.status = "retry_wait"
                job.next_attempt_at = utcnow() + timedelta(seconds=min(60, 2 ** max(1, job.attempts)))
            else:
                job.status = "partial_ready" if document.parse_status == "ready" else "failed"
            job.lease_owner = None
            job.lease_until = None
            emit(db, job, "error", {"message": message, "stage": job.stage, "status": job.status})
            db.commit()
