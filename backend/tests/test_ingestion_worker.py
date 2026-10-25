import hashlib
import json
from datetime import timedelta

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.ai.gateway import ModelGateway, ProviderError
from app.core.config import Settings
from app.db.models import (
    Base,
    ChunkEmbedding,
    ClassificationSuggestion,
    Document,
    DocumentChunk,
    EmbeddingProfile,
    Folder,
    IngestionJob,
    JobEvent,
    KnowledgeBase,
    Tag,
    User,
    utcnow,
)
from app.worker.pipeline import process_ingestion_job
from app.worker.queue import claim_job, heartbeat


@pytest.fixture
def ingestion_context(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'ingestion.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    config = Settings(_env_file=None, upload_root=tmp_path / "uploads", chunk_size_tokens=50, chunk_overlap_tokens=8, embedding_dimension=3, embedding_batch_size=2)
    with factory() as db:
        actor = User(email="ingestion@example.test", display_name="入库测试")
        db.add(actor)
        db.flush()
        kb = KnowledgeBase(owner_id=actor.id, name="测试知识库")
        db.add(kb)
        db.flush()
        content = ("# 检索增强生成\n" + "真实证据属于本知识库。模型服务未配置时也必须可读可搜索。\n" * 15).encode()
        document = Document(kb_id=kb.id, owner_id=actor.id, display_name="研究.md", original_filename="研究.md", mime_type="text/markdown", ext="md", sha256=hashlib.sha256(content).hexdigest(), size_bytes=len(content), storage_key=f"{kb.id}/document/original")
        db.add(document)
        db.flush()
        path = config.upload_root / document.storage_key
        path.parent.mkdir(parents=True)
        path.write_bytes(content)
        job = IngestionJob(document_id=document.id, kb_id=kb.id)
        db.add(job)
        db.commit()
        yield factory, config, document.id, job.id
    engine.dispose()


def test_no_key_ingestion_is_partial_ready_with_durable_chunks(ingestion_context):
    factory, config, document_id, job_id = ingestion_context
    with factory() as db:
        claimed = claim_job(db, "worker-a", 60)
        assert claimed.id == job_id
    process_ingestion_job(job_id, factory, config, owner="worker-a")
    with factory() as db:
        document = db.get(Document, document_id)
        job = db.get(IngestionJob, job_id)
        assert document.parse_status == "ready"
        assert document.index_status == document.summary_status == document.classification_status == "unconfigured"
        assert job.status == "partial_ready"
        assert job.lease_owner is None
        chunks = db.scalars(select(DocumentChunk).where(DocumentChunk.document_id == document_id)).all()
        assert len(chunks) > 2
        assert any("真实证据" in chunk.content for chunk in chunks)
        events = db.scalars(select(JobEvent).where(JobEvent.job_id == job_id).order_by(JobEvent.sequence)).all()
        assert [event.sequence for event in events] == list(range(1, len(events) + 1))
        assert events[-1].type == "completed"


def test_claim_lease_heartbeat_and_expiry_recovery(ingestion_context):
    factory, _, _, job_id = ingestion_context
    with factory() as db:
        first = claim_job(db, "worker-a", 60)
        assert first.attempts == 1
        assert claim_job(db, "worker-b", 60) is None
        assert heartbeat(db, job_id, "wrong-owner", 60) is False
        assert heartbeat(db, job_id, "worker-a", 60) is True
        first.lease_until = utcnow() - timedelta(seconds=1)
        db.commit()
    with factory() as db:
        recovered = claim_job(db, "worker-b", 60)
        assert recovered.id == job_id
        assert recovered.attempts == 2
        assert recovered.lease_owner == "worker-b"


def test_exhausted_expired_lease_is_not_stranded(ingestion_context):
    factory, _, _, job_id = ingestion_context
    with factory() as db:
        job = db.get(IngestionJob, job_id)
        job.status = "running"
        job.attempts = 3
        job.lease_until = utcnow() - timedelta(seconds=1)
        db.commit()
        assert claim_job(db, "worker", 60, 3) is None
        assert db.get(IngestionJob, job_id).status == "failed"


def test_cancelled_or_deleted_document_is_not_processed(ingestion_context):
    factory, config, document_id, job_id = ingestion_context
    with factory() as db:
        db.get(Document, document_id).deleted_at = utcnow()
        db.commit()
    process_ingestion_job(job_id, factory, config)
    with factory() as db:
        assert db.get(IngestionJob, job_id).status == "cancelled"
        assert db.scalar(select(func.count(DocumentChunk.id))) == 0


def test_embedding_batches_resume_without_repaying_and_metadata_changes_do_not_reparse(ingestion_context):
    factory, config, document_id, job_id = ingestion_context
    config.embedding_base_url = "https://embedding.invalid/v1"
    config.embedding_api_key = "test-only-key"
    config.embedding_model = "fake-test-embedding"

    class FakeGateway(ModelGateway):
        def __init__(self):
            super().__init__(config)
            self.calls = []
            self.fail_second = True

        def embed(self, texts):
            self.calls.append(texts)
            if len(self.calls) == 2 and self.fail_second:
                raise ProviderError("测试中的可重试故障", retryable=True)
            return [[0.1, 0.2, 0.3] for _ in texts]

    gateway = FakeGateway()
    with factory() as db:
        claim_job(db, "worker", 60)
    process_ingestion_job(job_id, factory, config, gateway, "worker")
    with factory() as db:
        assert db.get(IngestionJob, job_id).status == "retry_wait"
        assert db.scalar(select(func.count(ChunkEmbedding.id))) == 2
        first_chunk_ids = set(db.scalars(select(DocumentChunk.id)))
        first_embedded = set(db.scalars(select(ChunkEmbedding.chunk_id)))
        document = db.get(Document, document_id)
        document.display_name = "人工重命名.md"
        document.version += 1
        job = db.get(IngestionJob, job_id)
        job.next_attempt_at = utcnow() - timedelta(seconds=1)
        db.commit()
        claim_job(db, "worker", 60)
    gateway.fail_second = False
    call_count = len(gateway.calls)
    process_ingestion_job(job_id, factory, config, gateway, "worker")
    with factory() as db:
        assert db.get(Document, document_id).index_status == "ready"
        assert set(db.scalars(select(DocumentChunk.id))) == first_chunk_ids
        assert set(db.scalars(select(ChunkEmbedding.chunk_id))) == first_chunk_ids
        assert first_embedded.issubset(first_chunk_ids)
        assert len(gateway.calls) > call_count
        assert sum(len(batch) for batch in gateway.calls[call_count:]) == len(first_chunk_ids) - 2
        assert db.scalar(select(func.count(EmbeddingProfile.id))) == 1


def test_reindex_only_updates_vectors_not_summaries(ingestion_context):
    factory, config, document_id, job_id = ingestion_context
    process_ingestion_job(job_id, factory, config)
    with factory() as db:
        document = db.get(Document, document_id)
        document.short_summary = "保留的人工摘要"
        document.summary_status = "ready"
        document.classification_status = "ready"
        job = IngestionJob(document_id=document_id, kb_id=document.kb_id, kind="reindex")
        db.add(job)
        db.commit()
        reindex_id = job.id
        chunk_ids = set(db.scalars(select(DocumentChunk.id)))
    process_ingestion_job(reindex_id, factory, config)
    with factory() as db:
        document = db.get(Document, document_id)
        assert document.short_summary == "保留的人工摘要"
        assert document.summary_status == document.classification_status == "ready"
        assert set(db.scalars(select(DocumentChunk.id))) == chunk_ids
        assert db.get(IngestionJob, reindex_id).status == "partial_ready"


def test_full_fake_ai_pipeline_persists_suggestions_without_applying(ingestion_context):
    factory, config, document_id, job_id = ingestion_context

    class FakeGateway:
        llm_configured = True
        embeddings_configured = False

        def chat(self, messages, *, json_mode=False, max_tokens=0):
            prompt = messages[-1]["content"]
            if "同时生成文档摘要与分类建议" in messages[0]["content"]:
                return json.dumps({"summary": {"short_summary": "研究短摘要", "detailed_summary": "研究详细摘要", "keywords": ["RAG"], "main_topics": ["知识库"]}, "classification": {"existing_folder_id": None, "proposed_folder_path": "研究", "existing_tag_ids": [], "new_tag_names": ["检索", "知识库", "RAG"], "short_summary": "分类摘要", "reason": "研究资料", "confidence_hint": "未经校准的启发式"}})
            if "为文档建议分类" in prompt:
                return json.dumps({"existing_folder_id": None, "proposed_folder_path": "研究", "existing_tag_ids": [], "new_tag_names": ["检索", "知识库", "RAG"], "short_summary": "分类摘要", "reason": "研究资料", "confidence_hint": "未经校准的启发式"})
            if json_mode:
                return json.dumps({"short_summary": "研究短摘要", "detailed_summary": "研究详细摘要", "keywords": ["RAG"], "main_topics": ["知识库"]})
            return "章节中的研究事实"

    process_ingestion_job(job_id, factory, config, FakeGateway())
    with factory() as db:
        document = db.get(Document, document_id)
        assert document.summary_status == document.classification_status == "ready"
        assert document.short_summary == "研究短摘要"
        assert document.summary_metadata == {"keywords": ["RAG"], "main_topics": ["知识库"]}
        suggestion = db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == document_id))
        assert suggestion.status == "pending"
        assert suggestion.payload["new_tag_names"] == ["检索", "知识库", "RAG"]
        assert document.folder_id is None


def test_provider_failure_after_lease_transfer_cannot_mark_document_failed(ingestion_context):
    factory, config, document_id, job_id = ingestion_context
    config.embedding_base_url = "https://embedding.invalid/v1"
    config.embedding_api_key = "test-only-key"
    config.embedding_model = "fake-lease-transfer"
    with factory() as db:
        claim_job(db, "old-worker", 60)

    class TransferredGateway(ModelGateway):
        def embed(self, texts):
            with factory() as db:
                db.get(IngestionJob, job_id).lease_owner = "new-worker"
                db.commit()
            raise ProviderError("provider failed after recovery", retryable=True)

    process_ingestion_job(job_id, factory, config, TransferredGateway(config), "old-worker")
    with factory() as db:
        assert db.get(IngestionJob, job_id).lease_owner == "new-worker"
        assert db.get(IngestionJob, job_id).status == "running"
        document = db.get(Document, document_id)
        assert document.index_status != "failed"
        assert document.error is None


JOINT_SUMMARY = {"short_summary": "研究短摘要", "detailed_summary": "研究详细摘要", "keywords": ["检索"], "main_topics": ["研究"]}
JOINT_CLASSIFICATION = {"existing_folder_id": None, "existing_tag_ids": [], "new_tag_names": ["研究"], "short_summary": "研究资料", "reason": "资料包含研究事实"}


def test_joint_model_call_starts_after_text_and_vectors_are_durable(ingestion_context):
    factory, config, document_id, job_id = ingestion_context
    config.embedding_base_url, config.embedding_api_key, config.embedding_model = "https://test.invalid/v1", "test-only", "test-embedding"

    class Gateway(ModelGateway):
        calls = 0
        llm_configured = True

        def embed(self, texts):
            return [[1.0, 0.1, 0.2] for _ in texts]

        def chat(self, messages, **kwargs):
            self.calls += 1
            with factory() as reader:
                document = reader.get(Document, document_id)
                assert document.parse_status == document.index_status == "ready"
                assert reader.scalar(select(func.count(DocumentChunk.id)).where(DocumentChunk.document_id == document_id)) > 0
                assert reader.scalar(select(func.count(ChunkEmbedding.id))) > 0
            assert "同时生成文档摘要与分类建议" in messages[0]["content"]
            return json.dumps({"summary": JOINT_SUMMARY, "classification": JOINT_CLASSIFICATION})

    gateway = Gateway(config)
    process_ingestion_job(job_id, factory, config, gateway)
    assert gateway.calls == 1
    with factory() as db:
        assert db.get(IngestionJob, job_id).status == "completed"
        assert db.get(Document, document_id).summary_status == db.get(Document, document_id).classification_status == "ready"


@pytest.mark.parametrize("failed_stage", ["summary", "classification"])
def test_joint_half_failure_retries_only_missing_stage(ingestion_context, failed_stage):
    factory, config, document_id, job_id = ingestion_context

    class Gateway:
        llm_configured = True
        embeddings_configured = False
        calls = []

        def chat(self, messages, **kwargs):
            self.calls.append(messages)
            if len(self.calls) == 1:
                return json.dumps({"summary": JOINT_SUMMARY, "classification": JOINT_CLASSIFICATION, failed_stage: {"invalid": True}})
            assert "同时生成文档摘要与分类建议" not in messages[0]["content"]
            return json.dumps(JOINT_SUMMARY if failed_stage == "summary" else JOINT_CLASSIFICATION)

    gateway = Gateway()
    process_ingestion_job(job_id, factory, config, gateway)
    with factory() as db:
        document = db.get(Document, document_id)
        assert getattr(document, f"{failed_stage}_status") == "failed"
        successful_stage = "summary" if failed_stage == "classification" else "classification"
        assert getattr(document, f"{successful_stage}_status") == "ready"
        job = db.get(IngestionJob, job_id)
        job.status = "queued"
        setattr(document, f"{failed_stage}_status", "queued")
        db.commit()
    process_ingestion_job(job_id, factory, config, gateway)
    assert len(gateway.calls) == 2
    with factory() as db:
        document = db.get(Document, document_id)
        assert document.summary_status == document.classification_status == "ready"
        assert document.short_summary == JOINT_SUMMARY["short_summary"]
        assert db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == document_id)).payload["new_tag_names"] == ["研究"]


@pytest.mark.parametrize("change", ["catalog", "document", "folder"])
def test_joint_classification_rechecks_document_and_tag_catalog_only(ingestion_context, change):
    factory, config, document_id, job_id = ingestion_context

    class Gateway:
        llm_configured = True
        embeddings_configured = False

        def chat(self, messages, **kwargs):
            with factory() as editor:
                document = editor.get(Document, document_id)
                if change == "catalog":
                    editor.add(Tag(kb_id=document.kb_id, name="并发新标签", normalized_name="并发新标签"))
                elif change == "folder":
                    editor.add(Folder(kb_id=document.kb_id, name="目录变化不影响标签建议"))
                else:
                    document.display_name, document.version = "人工改名.md", document.version + 1
                editor.commit()
            return json.dumps({"summary": JOINT_SUMMARY, "classification": JOINT_CLASSIFICATION})

    process_ingestion_job(job_id, factory, config, Gateway())
    with factory() as db:
        document = db.get(Document, document_id)
        if change == "folder":
            assert document.summary_status == document.classification_status == "ready"
            suggestion = db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == document_id))
            assert suggestion and suggestion.payload["existing_folder_id"] is None and suggestion.payload["proposed_folder_path"] is None
            return
        assert document.summary_status == "ready" and document.classification_status == "failed"
        assert db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == document_id)) is None
        assert db.get(IngestionJob, job_id).status == "retry_wait"


@pytest.mark.parametrize("review_status", ["applied", "rejected"])
def test_retry_never_replaces_reviewed_classification(ingestion_context, review_status):
    factory, config, document_id, job_id = ingestion_context
    with factory() as db:
        document = db.get(Document, document_id)
        db.add(ClassificationSuggestion(document_id=document_id, kb_id=document.kb_id, document_version=document.version, status=review_status, payload={"reviewed": True}))
        document.classification_status = "failed"
        db.commit()

    class Gateway:
        llm_configured = True
        embeddings_configured = False

        def chat(self, messages, **kwargs):
            assert "同时生成文档摘要与分类建议" not in messages[0]["content"]
            return json.dumps(JOINT_SUMMARY)

    process_ingestion_job(job_id, factory, config, Gateway())
    with factory() as db:
        current = db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == document_id))
        assert current.status == review_status and current.payload == {"reviewed": True}
        assert db.get(Document, document_id).classification_status == "ready"


@pytest.mark.parametrize("provider_fails", [False, True])
def test_joint_completion_from_old_owner_never_persists_after_handoff(ingestion_context, provider_fails):
    factory, config, document_id, job_id = ingestion_context
    with factory() as db:
        claim_job(db, "old-enrichment-worker", 60)

    class Gateway:
        llm_configured = True
        embeddings_configured = False

        def chat(self, messages, **kwargs):
            with factory() as recovery:
                recovery.get(IngestionJob, job_id).lease_owner = "new-enrichment-worker"
                recovery.commit()
            if provider_fails:
                raise ProviderError("controlled provider error after handoff", retryable=True)
            return json.dumps({"summary": JOINT_SUMMARY, "classification": JOINT_CLASSIFICATION})

    process_ingestion_job(job_id, factory, config, Gateway(), "old-enrichment-worker")
    with factory() as db:
        job = db.get(IngestionJob, job_id)
        assert job.lease_owner == "new-enrichment-worker" and job.status == "running"
        document = db.get(Document, document_id)
        assert document.summary_status != "ready" and document.summary_status != "failed"
        assert db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == document_id)) is None


@pytest.mark.parametrize("review_status", ["applied", "rejected"])
def test_review_during_joint_request_wins_over_generated_classification(ingestion_context, review_status):
    factory, config, document_id, job_id = ingestion_context
    with factory() as db:
        document = db.get(Document, document_id)
        db.add(ClassificationSuggestion(document_id=document_id, kb_id=document.kb_id, document_version=document.version, payload={"old": True}, status="pending"))
        document.classification_status = "failed"
        db.commit()

    class Gateway:
        llm_configured = True
        embeddings_configured = False

        def chat(self, messages, **kwargs):
            with factory() as review:
                item = review.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == document_id))
                item.status, item.payload = review_status, {"human_review": True}
                document = review.get(Document, document_id)
                document.version += 1
                review.commit()
            return json.dumps({"summary": JOINT_SUMMARY, "classification": JOINT_CLASSIFICATION})

    process_ingestion_job(job_id, factory, config, Gateway())
    with factory() as db:
        current = db.scalar(select(ClassificationSuggestion).where(ClassificationSuggestion.document_id == document_id))
        assert current.status == review_status and current.payload == {"human_review": True}
        assert db.get(Document, document_id).summary_status == db.get(Document, document_id).classification_status == "ready"


def test_classification_only_review_refresh_preserves_failed_independent_stages(ingestion_context):
    factory, config, document_id, job_id = ingestion_context
    process_ingestion_job(job_id, factory, config)
    with factory() as db:
        document = db.get(Document, document_id)
        document.index_status = document.summary_status = "failed"
        document.classification_status = "queued"
        document.error = "independent index failure"
        job = db.get(IngestionJob, job_id)
        job.status, job.payload = "queued", {"classification_only": True}
        db.add(ClassificationSuggestion(document_id=document_id, kb_id=document.kb_id, document_version=document.version, payload={"previous": True}, status="pending"))
        db.commit()

    class Gateway:
        llm_configured = True
        embeddings_configured = True

        def embed(self, texts):
            pytest.fail("review refresh must not retry an independent embedding stage")

        def chat(self, messages, **kwargs):
            assert "知识分类助手" in messages[0]["content"]
            return json.dumps(JOINT_CLASSIFICATION)

    process_ingestion_job(job_id, factory, config, Gateway())
    with factory() as db:
        document = db.get(Document, document_id)
        assert document.index_status == document.summary_status == "failed"
        assert document.classification_status == "ready"
        assert document.error == "independent index failure"
        assert db.get(IngestionJob, job_id).status == "completed"
