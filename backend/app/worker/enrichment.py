"""Coordinate enrichment checkpoints without holding locks during model calls."""

from dataclasses import dataclass
from types import SimpleNamespace

from sqlalchemy import select

from app.ai.gateway import AIUnavailable, ProviderError
from app.db.models import ClassificationSuggestion, Folder, Tag
from app.ingestion.enrichment import EnrichmentOutcome, classify_document, enrich_sections, summarize_sections


@dataclass(frozen=True)
class CatalogSnapshot:
    folders: list[dict]
    tags: list[dict]
    versions: tuple


def catalog_snapshot(db, kb_id: str) -> CatalogSnapshot:
    folders = list(db.scalars(select(Folder).where(Folder.kb_id == kb_id, Folder.deleted_at.is_(None)).order_by(Folder.id).execution_options(populate_existing=True)))
    tags = list(db.scalars(select(Tag).where(Tag.kb_id == kb_id).order_by(Tag.id).execution_options(populate_existing=True)))
    return CatalogSnapshot(
        [{"id": folder.id, "name": folder.name, "parent_id": folder.parent_id} for folder in folders],
        [{"id": tag.id, "name": tag.name, "aliases": list(tag.aliases)} for tag in tags],
        (tuple((folder.id, folder.version) for folder in folders), tuple((tag.id, tag.version) for tag in tags)),
    )


def process_enrichment(db, document, sections, gateway, settings, check_active, stage, *, classification_only: bool = False) -> list[ProviderError]:
    def suggestion():
        return db.scalar(select(ClassificationSuggestion).where(
            ClassificationSuggestion.document_id == document.id,
        ).with_for_update().execution_options(populate_existing=True))

    check_active(lock=True)
    current = suggestion()
    if current and current.status != "pending":
        document.classification_status = "ready"
    need_summary = not classification_only and document.summary_status != "ready"
    need_classification = document.classification_status != "ready"
    if not gateway.llm_configured:
        if need_summary:
            document.summary_status = "unconfigured"
        if need_classification:
            document.classification_status = "unconfigured"
        db.commit()
        return []
    if not need_summary and not need_classification:
        db.commit()
        return []
    snapshot = catalog_snapshot(db, document.kb_id) if need_classification else None
    base_version, title = document.version, document.display_name
    inputs = [SimpleNamespace(plain_text=section.plain_text, section_summary=section.section_summary) for section in sections]
    source_summary = document.detailed_summary or "\n".join(item.section_summary for item in inputs if item.section_summary) or "\n".join(item.plain_text for item in inputs[:3])
    db.commit()

    def save_section(index: int, text: str) -> None:
        check_active(lock=True)
        sections[index].section_summary = text
        db.commit()

    outcome = EnrichmentOutcome()
    if need_summary and need_classification:
        stage("enriching", 60)
        outcome = enrich_sections(inputs, title, snapshot.folders, snapshot.tags, gateway, settings, save_section)
    elif need_summary:
        stage("summarizing", 60)
        try:
            outcome.summary = summarize_sections(inputs, gateway, settings, save_section)
        except (AIUnavailable, ProviderError) as error:
            outcome.errors["summary"] = _provider_error(error)
    else:
        stage("classifying", 85)
        try:
            outcome.classification = classify_document(title, source_summary, snapshot.folders, snapshot.tags, gateway, int(settings.summary_input_tokens))
        except (AIUnavailable, ProviderError) as error:
            outcome.errors["classification"] = _provider_error(error)

    errors = []
    if need_summary:
        check_active(lock=True)
        if document.summary_status != "ready":
            if outcome.summary:
                document.short_summary = outcome.summary.short_summary
                document.detailed_summary = outcome.summary.detailed_summary
                document.summary_metadata = {"keywords": outcome.summary.keywords, "main_topics": outcome.summary.main_topics}
                document.summary_status = "ready"
            else:
                document.summary_status = "failed"
                errors.append(outcome.errors["summary"])
        db.commit()
    if need_classification:
        check_active(lock=True)
        current = suggestion()
        if current and current.status != "pending":
            # A user reviewed the existing suggestion while this call was in
            # flight. Their choice wins, including rejection.
            document.classification_status = "ready"
            db.commit()
            return errors
        if outcome.classification:
            fresh = catalog_snapshot(db, document.kb_id)
            if document.version != base_version or fresh != snapshot:
                outcome.errors["classification"] = ProviderError("文档或目录标签已更新，分类建议需基于最新资料重试", retryable=True)
            else:
                if current is None:
                    current = ClassificationSuggestion(document_id=document.id, kb_id=document.kb_id, document_version=base_version)
                    db.add(current)
                current.payload = outcome.classification.model_dump()
                current.document_version, current.model, current.status = base_version, settings.llm_model, "pending"
                document.classification_status = "ready"
        if "classification" in outcome.errors:
            document.classification_status = "failed"
            errors.append(outcome.errors["classification"])
        db.commit()
    return errors


def _provider_error(error):
    return error if isinstance(error, ProviderError) else ProviderError(str(error))
