"""Opt-in real PostgreSQL ordering/pgvector admission on the dedicated test DB."""

import os

import pytest
from retrieval_fixtures import offline_settings, seed_retrieval_corpus
from sqlalchemy import case
from test_ingestion_postgres import pg_factory as pg_factory
from test_retrieval_pagination import assert_page_consistency

from app.db.models import ChunkEmbedding, DocumentChunk, EmbeddingProfile, new_id
from app.retrieval.search import _candidates, scoped_query, search_knowledge

pytestmark = pytest.mark.skipif(not os.getenv("PG_INGESTION_TEST_URL"), reason="Set isolated PG_INGESTION_TEST_URL")


def test_pg_static_pages_and_deep_offsets_use_the_same_ranked_window(pg_factory):
    with pg_factory() as db:
        actor, kb, _ = seed_retrieval_corpus(db)
        page, keys = assert_page_consistency(db, actor, kb)
        assert len(keys(page(10, 240))) == 10
        assert keys(page(10, 240)) == keys(page(100, 200))[40:50]
        assert page(10)["total"] == page(10, 240)["total"] == 500


@pytest.mark.parametrize("mode", ["keyword", "hybrid"])
def test_pg_long_document_admission_preserves_evidence_and_equal_vector_ties(pg_factory, monkeypatch, mode):
    with pg_factory() as db:
        actor, kb, ids = seed_retrieval_corpus(db, 20, 100, target=(10, 0))
        fingerprint = "pagination-" + new_id()

        class Gateway:
            embeddings_configured = True
            profile_fingerprint = fingerprint

            def __init__(self, _settings):
                pass

            def embed(self, _queries):
                return [[1.0, 0.0, 0.0]]

        monkeypatch.setattr("app.retrieval.search.ModelGateway", Gateway)
        if mode == "hybrid":
            profile = EmbeddingProfile(fingerprint=fingerprint, model_name="controlled", dimension=3)
            db.add(profile)
            db.flush()
            db.add_all(ChunkEmbedding(kb_id=kb.id, chunk_id=key, profile_id=profile.id, embedding=[1.0, 0.0, 0.0])
                       for key in ids.values())
            db.flush()
        result = search_knowledge(db, actor, {
            "query": "alpha beta gamma", "kb_ids": [kb.id], "mode": mode, "limit": 10,
        }, offline_settings())
        assert result["mode"] == mode
        assert result["items"][0]["chunk_id"] == ids[10, 0]
        assert len({item["document_id"] for item in result["items"]}) == 10
        assert result["total"] == 600


def test_pg_candidate_diversity_never_precedes_primary_relevance(pg_factory):
    with pg_factory() as db:
        actor, kb, ids = seed_retrieval_corpus(db, 2, 2, text_factory=lambda doc, _chunk: "needle" if doc == 0 else "ordinary")
        statement, _ = scoped_query(db, actor, {"kb_ids": [kb.id]})
        relevance = case((DocumentChunk.content == "needle", 1), else_=0)
        rows = _candidates(db, statement, relevance.desc(), 2, 100)
        assert [row[0].id for row in rows] == [ids[0, 0], ids[0, 1]]
