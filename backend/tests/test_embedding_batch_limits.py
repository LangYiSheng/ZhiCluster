"""Provider-declared batch limits adapt without changing model, vectors or sources."""

import json
from collections import OrderedDict

import httpx
import pytest
from sqlalchemy import func, select

from app.ai import gateway as gateway_module
from app.ai.gateway import ModelGateway, ProviderError
from app.core.config import Settings
from app.db.models import (
    ChunkEmbedding,
    Document,
    DocumentChunk,
    DocumentSection,
    EmbeddingProfile,
    IngestionJob,
    KnowledgeBase,
)
from app.retrieval.search import search_knowledge
from app.services.permissions import get_actor
from app.worker.pipeline import process_ingestion_job


@pytest.fixture(autouse=True)
def isolated_limit_cache(monkeypatch):
    monkeypatch.setattr(gateway_module, "_EMBEDDING_BATCH_LIMITS", OrderedDict())


def settings(**updates):
    return Settings(_env_file=None, embedding_base_url="https://controlled.invalid/v1", embedding_api_key="test-private-key",
        embedding_model="controlled-embedding", embedding_dimension=3, embedding_batch_size=32, embedding_max_retries=0, **updates)


def batch_error(limit):
    # This is the actual service error shape, with synthetic sensitive fields.
    return httpx.Response(400, json={"error": {"code": "invalid_parameter_error", "type": "invalid_request_error",
        "message": f"<400> InternalError.Algo.InvalidParameter: Value error, batch size is invalid, it should not be larger than {limit}.: input.contents",
        "api_key": "test-private-key", "input": "private document text"}})


def vectors_for(inputs):
    return httpx.Response(200, json={"data": [{"index": index, "embedding": [float(text), 1.0, 0.5]}
        for index, text in reversed(list(enumerate(inputs)))]})


def test_actual_declared_batch_limit_preserves_order_and_is_remembered_between_gateways():
    calls = []

    def respond(request):
        payload = json.loads(request.content)
        assert payload["model"] == "controlled-embedding" and "dimensions" not in payload
        calls.append(payload["input"])
        return batch_error(25) if len(payload["input"]) > 25 else vectors_for(payload["input"])

    configured = settings()
    first = ModelGateway(configured, transport=httpx.MockTransport(respond))
    fingerprint = first.profile_fingerprint
    result = first.embed([str(index) for index in range(71)])
    assert [len(call) for call in calls] == [32, 25, 25, 21]
    assert [vector[0] for vector in result] == list(range(71))
    second = ModelGateway(configured, transport=httpx.MockTransport(respond))
    assert second.profile_fingerprint == fingerprint
    second.embed([str(index) for index in range(31)])
    assert [len(call) for call in calls[-2:]] == [25, 6]
    assert all(len(cache_key) == 64 and "private" not in cache_key for cache_key in gateway_module._EMBEDDING_BATCH_LIMITS)


def test_batch_error_reports_only_safe_numeric_limits():
    gateway = ModelGateway(settings(), transport=httpx.MockTransport(lambda _: batch_error(25)))
    with pytest.raises(ProviderError) as failure:
        gateway._request("embedding", "embeddings", {"input": ["private document text"] * 32})
    assert failure.value.code == "embedding_batch_limit" and failure.value.batch_limit == 25
    assert "25" in str(failure.value) and "32" in str(failure.value)
    assert "test-private-key" not in str(failure.value) and "private document" not in str(failure.value)


def test_learned_limit_is_scoped_to_provider_model_and_credential():
    configured = settings()
    learned_calls = []

    def limited(request):
        inputs = json.loads(request.content)["input"]
        learned_calls.append(len(inputs))
        return batch_error(25) if len(inputs) > 25 else vectors_for(inputs)

    ModelGateway(configured, transport=httpx.MockTransport(limited)).embed([str(index) for index in range(32)])
    assert learned_calls == [32, 25, 7]
    for update in ({"embedding_model": "another-model"}, {"embedding_api_key": "another-secret"},
            {"embedding_base_url": "https://another-provider.invalid/v1"}):
        counts = []

        def unrestricted(request, observed=counts):
            inputs = json.loads(request.content)["input"]
            observed.append(len(inputs))
            return vectors_for(inputs)

        changed = configured.model_copy(update=update, deep=True)
        ModelGateway(changed, transport=httpx.MockTransport(unrestricted)).embed([str(index) for index in range(32)])
        assert counts == [32]


@pytest.mark.parametrize("message,code", [
    ("Unknown model private document text test-private-key", "embedding_invalid_request"),
    ("Unsupported dimensions 2048: private document text test-private-key", "embedding_dimension_rejected"),
    ("Input tokens exceed the maximum context limit: private document text", "embedding_input_too_long"),
    ("Some unrelated parameter is invalid", "embedding_invalid_request"),
])
def test_unrelated_400_never_splits_or_retries_and_never_echoes_provider_body(message, code):
    calls = []

    def respond(request):
        calls.append(json.loads(request.content))
        return httpx.Response(400, json={"error": {"message": message}})

    gateway = ModelGateway(settings(), transport=httpx.MockTransport(respond))
    with pytest.raises(ProviderError) as failure:
        gateway.embed(["private document text"] * 32)
    assert len(calls) == 1 and failure.value.code == code and not failure.value.retryable
    assert "private document" not in str(failure.value) and "test-private-key" not in str(failure.value)
    assert not gateway_module._EMBEDDING_BATCH_LIMITS


@pytest.mark.parametrize("limit", [0, 32, 100000])
def test_non_reducing_or_invalid_bounds_never_trigger_more_requests(limit):
    calls = []

    def respond(request):
        calls.append(request)
        return batch_error(limit)

    gateway = ModelGateway(settings(), transport=httpx.MockTransport(respond))
    with pytest.raises(ProviderError):
        gateway.embed(["text"] * 32)
    assert len(calls) == 1


def test_further_limit_reduction_does_not_resend_already_successful_sub_batches():
    calls, succeeded = [], []

    def respond(request):
        payload = json.loads(request.content)
        inputs = payload["input"]
        calls.append(inputs)
        bound = 25 if not succeeded else 12
        if len(inputs) > bound:
            return batch_error(bound)
        succeeded.extend(inputs)
        return vectors_for(inputs)

    gateway = ModelGateway(settings(), transport=httpx.MockTransport(respond))
    result = gateway.embed([str(index) for index in range(60)])
    assert [vector[0] for vector in result] == list(range(60))
    assert succeeded == [str(index) for index in range(60)]
    assert [len(call) for call in calls] == [32, 25, 25, 12, 12, 11]


def test_adaptation_budget_is_bounded_and_empty_inputs_make_no_request():
    calls = []

    def respond(request):
        count = len(json.loads(request.content)["input"])
        calls.append(count)
        return batch_error(count - 1)

    gateway = ModelGateway(settings(), transport=httpx.MockTransport(respond))
    with pytest.raises(ProviderError):
        gateway.embed(["text"] * 32)
    assert calls == [32, 31, 30, 29, 28]
    before = len(calls)
    with pytest.raises(ProviderError, match="非空"):
        gateway.embed(["valid", " "])
    assert len(calls) == before and gateway.embed([]) == []


def test_worker_reuses_parsed_chunks_and_existing_vectors_then_query_uses_same_profile(factory, monkeypatch):
    configured = settings()
    requested_counts, sources = [], []

    def respond(request):
        payload = json.loads(request.content)
        assert request.url.path.endswith("/embeddings"), "Summaries/classification must not be called again"
        assert payload["model"] == configured.embedding_model
        requested_counts.append(len(payload["input"]))
        if len(payload["input"]) > 25:
            return batch_error(25)
        sources.extend(payload["input"])
        return httpx.Response(200, json={"data": [{"index": index, "embedding": [1.0, 0.5, 0.25]}
            for index, _ in enumerate(payload["input"])]})

    original_init = ModelGateway.__init__

    def initialize(self, config, **kwargs):
        kwargs.pop("transport", None)
        original_init(self, config, transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr(ModelGateway, "__init__", initialize)
    with factory() as db:
        actor = get_actor(db)
        kb = db.scalar(select(KnowledgeBase))
        document = Document(kb_id=kb.id, owner_id=actor.id, display_name="parsed.pptx", original_filename="parsed.pptx",
            mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation", ext="pptx", sha256="a" * 64,
            size_bytes=20, storage_key="do-not-read-or-reparse", parse_status="ready", index_status="failed",
            summary_status="ready", classification_status="ready", short_summary="Existing summary")
        db.add(document)
        db.flush()
        section = DocumentSection(kb_id=kb.id, document_id=document.id, heading="Existing slide",
            plain_text="\n".join(f"evidence {index}" for index in range(41)), anchors={"slide_start": 1, "slide_end": 1})
        profile = EmbeddingProfile(fingerprint=ModelGateway(configured).profile_fingerprint, model_name=configured.embedding_model,
            dimension=configured.embedding_dimension)
        db.add_all([section, profile])
        db.flush()
        original_ids = []
        for index in range(41):
            chunk = DocumentChunk(kb_id=kb.id, document_id=document.id, section_id=section.id, chunk_index=index,
                content=f"evidence {index}", token_count=3, anchors=section.anchors)
            db.add(chunk)
            db.flush()
            if index < 5:
                vector = ChunkEmbedding(kb_id=kb.id, chunk_id=chunk.id, profile_id=profile.id, embedding=[0.2, 0.4, 0.6])
                db.add(vector)
                db.flush()
                original_ids.append(vector.id)
        job = IngestionJob(kb_id=kb.id, document_id=document.id, kind="reindex")
        db.add(job)
        db.commit()
        document_id, kb_id, job_id = document.id, kb.id, job.id
    process_ingestion_job(job_id, factory, configured)
    assert requested_counts == [32, 25, 7, 4]
    assert all("evidence 0\n" not in text for text in sources)
    with factory() as db:
        document = db.get(Document, document_id)
        assert document.index_status == "ready" and document.short_summary == "Existing summary"
        assert db.get(IngestionJob, job_id).status == "completed"
        assert db.scalar(select(func.count()).select_from(ChunkEmbedding)) == 41
        for vector_id in original_ids:
            assert db.get(ChunkEmbedding, vector_id).embedding == [0.2, 0.4, 0.6]
        found = search_knowledge(db, get_actor(db), {"query": "unrelated query", "kb_ids": [kb_id], "mode": "hybrid"}, configured)
        assert found["mode"] == "hybrid" and {hit["document_id"] for hit in found["items"]} == {document_id}
