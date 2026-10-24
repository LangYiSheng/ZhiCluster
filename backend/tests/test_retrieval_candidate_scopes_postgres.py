"""Opt-in candidate admission scope and non-tied vector ordering on real PG."""

import os

import pytest
from retrieval_fixtures import offline_settings, seed_retrieval_corpus
from test_ingestion_postgres import pg_factory as pg_factory

from app.db.models import (
    ChunkEmbedding,
    Document,
    DocumentChunk,
    DocumentTag,
    EmbeddingProfile,
    Folder,
    Tag,
    new_id,
    utcnow,
)
from app.retrieval.search import _candidates, scoped_query, search_knowledge

pytestmark = pytest.mark.skipif(not os.getenv("PG_INGESTION_TEST_URL"), reason="Set isolated PG_INGESTION_TEST_URL")


def test_candidate_scope_tags_profile_and_non_tied_vector_direction(pg_factory, monkeypatch):
    with pg_factory() as db:
        actor, kb, ids = seed_retrieval_corpus(db, 6, 1, text_factory=lambda *_: "有来源锚点的中文材料。")
        _, foreign, foreign_ids = seed_retrieval_corpus(db, 1, 1, text_factory=lambda *_: "外部中文资料。")
        selected, outside = Folder(kb_id=kb.id, name="选中"), Folder(kb_id=kb.id, name="范围外")
        tag_a, tag_b = Tag(kb_id=kb.id, name="A", normalized_name="a"), Tag(kb_id=kb.id, name="B", normalized_name="b")
        current = EmbeddingProfile(fingerprint="current-" + new_id(), model_name="controlled", dimension=3)
        old = EmbeddingProfile(fingerprint="old-" + new_id(), model_name="controlled", dimension=2)
        db.add_all([selected, outside, tag_a, tag_b, current, old])
        db.flush()
        docs = {index: db.get(Document, db.get(DocumentChunk, ids[index, 0]).document_id) for index in range(6)}
        for index, doc in docs.items():
            doc.folder_id = outside.id if index == 2 else selected.id
            if index == 4:
                doc.deleted_at = utcnow()
            db.add(DocumentTag(kb_id=kb.id, document_id=doc.id, tag_id=tag_a.id))
            if index != 1:
                db.add(DocumentTag(kb_id=kb.id, document_id=doc.id, tag_id=tag_b.id))
            vector = [1, 0] if index == 3 else [.95, .3, 0] if index == 1 else [.8, .6, 0] if index == 5 else [1, 0, 0]
            db.add(ChunkEmbedding(kb_id=kb.id, chunk_id=ids[index, 0],
                                  profile_id=old.id if index == 3 else current.id, embedding=vector))
        db.add(ChunkEmbedding(kb_id=foreign.id, chunk_id=foreign_ids[0, 0],
                              profile_id=current.id, embedding=[1, 0, 0]))
        db.flush()

        class Gateway:
            embeddings_configured = True
            profile_fingerprint = current.fingerprint

            def __init__(self, _settings):
                pass

            def embed(self, queries):
                return [[1., 0., 0.] for _ in queries]

        monkeypatch.setattr("app.retrieval.search.ModelGateway", Gateway)
        request = {"query": "semantic-only probe", "kb_ids": [kb.id], "folder_ids": [selected.id],
                   "tag_ids": [tag_a.id, tag_b.id], "mode": "hybrid", "limit": 10}
        response = search_knowledge(db, actor, request, offline_settings())
        assert [item["chunk_id"] for item in response["items"]] == [ids[0, 0], ids[5, 0]]
        response = search_knowledge(db, actor, {**request, "tag_match": "any"}, offline_settings())
        assert [item["chunk_id"] for item in response["items"]] == [ids[0, 0], ids[1, 0], ids[5, 0]]
        response = search_knowledge(db, actor, {
            "query": "semantic-only probe", "kb_ids": [kb.id], "mode": "hybrid", "limit": 10,
        }, offline_settings())
        assert {item["chunk_id"] for item in response["items"]} == {ids[index, 0] for index in [0, 1, 2, 5]}

        statement, _ = scoped_query(db, actor, request)
        vectors = statement.join(ChunkEmbedding, ChunkEmbedding.chunk_id == DocumentChunk.id).where(
            ChunkEmbedding.profile_id == current.id,
        )
        rows = _candidates(db, vectors, ChunkEmbedding.embedding.cosine_distance([1., 0., 0.]), 1, 100)
        assert [row[0].id for row in rows] == [ids[0, 0]]
        # Extra caller predicates belong to the admitted scope, even when a
        # closer vector exists in the same folder/tag set.
        rows = _candidates(db, vectors.where(DocumentChunk.id == ids[5, 0]),
                           ChunkEmbedding.embedding.cosine_distance([1., 0., 0.]), 10, 100)
        assert [row[0].id for row in rows] == [ids[5, 0]]


def test_empty_candidate_pool_returns_empty_without_broadening_scope(pg_factory):
    with pg_factory() as db:
        actor, kb, _ = seed_retrieval_corpus(db, 1, 1, text_factory=lambda *_: "隔离的中文资料。")
        result = search_knowledge(db, actor, {
            "query": "absent-" + new_id(), "kb_ids": [kb.id], "mode": "keyword", "limit": 10,
        }, offline_settings())
        assert result["items"] == [] and result["total"] == 0
        assert result["kb_ids"] == [kb.id]
