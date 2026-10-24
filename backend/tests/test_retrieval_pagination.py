"""Stable static ranking windows without silently dropping reachable deep pages."""

import pytest
from retrieval_fixtures import offline_settings, seed_retrieval_corpus
from sqlalchemy import case

from app.db.models import DocumentChunk
from app.retrieval.search import _candidates, scoped_query, search_knowledge


def assert_page_consistency(db, actor, kb):
    request = {"query": "alpha beta gamma", "kb_ids": [kb.id], "mode": "keyword"}

    def page(limit, offset=0):
        return search_knowledge(db, actor, {**request, "limit": limit, "offset": offset}, offline_settings())

    def keys(response):
        return [item["chunk_id"] for item in response["items"]]

    first, second = page(10), page(10, 10)
    assert keys(first) + keys(second) == keys(page(20))
    assert not set(keys(first)) & set(keys(second))
    return page, keys


@pytest.mark.parametrize("documents,chunks", [(2, 13), (25, 20)])
def test_static_keyword_pages_share_a_ranking_window(factory, documents, chunks):
    with factory() as db:
        actor, kb, _ = seed_retrieval_corpus(db, documents, chunks)
        page, keys = assert_page_consistency(db, actor, kb)
        first_hundred = keys(page(100))
        paged = [key for offset in range(0, min(100, documents * chunks), 10) for key in keys(page(10, offset))]
        assert paged == first_hundred
        assert len(set(paged)) == len(paged)


def test_deep_keyword_pages_remain_reachable_and_report_the_bounded_total(factory):
    with factory() as db:
        actor, kb, _ = seed_retrieval_corpus(db)
        page, keys = assert_page_consistency(db, actor, kb)
        assert page(10)["total"] == 500
        assert len(keys(page(10, 240))) == 10
        assert keys(page(10, 240)) == keys(page(100, 200))[40:50]
        assert len(keys(page(10, 490))) == 10
        assert page(10, 600)["items"] == []
        assert page(10, 600)["total"] == 500


def test_equal_relevance_long_documents_do_not_crowd_out_other_evidence(factory):
    with factory() as db:
        actor, kb, ids = seed_retrieval_corpus(db, 20, 100, target=(10, 0))
        result = search_knowledge(db, actor, {
            "query": "alpha beta gamma", "kb_ids": [kb.id], "mode": "keyword", "limit": 10,
        }, offline_settings())
        assert result["items"][0]["chunk_id"] == ids[10, 0]
        assert len({item["document_id"] for item in result["items"]}) == 10
        assert result["total"] == 600


def test_candidate_diversity_remains_secondary_to_primary_relevance(factory):
    with factory() as db:
        actor, kb, ids = seed_retrieval_corpus(db, 2, 2, text_factory=lambda doc, _chunk: "needle" if doc == 0 else "ordinary")
        statement, _ = scoped_query(db, actor, {"kb_ids": [kb.id]})
        relevance = case((DocumentChunk.content == "needle", 1), else_=0)
        rows = _candidates(db, statement, relevance.desc(), 2, 100)
        assert [row[0].id for row in rows] == [ids[0, 0], ids[0, 1]]
