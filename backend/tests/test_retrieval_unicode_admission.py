"""Known SQL normalization gap, kept as strict xfails until its planned migration.

Run with --runxfail to reproduce the current failures. ASCII/reverse controls
remain ordinary tests; these expected failures are not a completed repair.
"""

import os

import pytest
from sqlalchemy import select
from test_ingestion_postgres import pg_factory as pg_factory

from app.core.config import Settings, get_settings
from app.db.models import (
    Document,
    DocumentChunk,
    DocumentSection,
    KnowledgeBase,
    KnowledgeBaseMember,
    User,
    new_id,
)
from app.retrieval.ranking import lexical_scores
from app.retrieval.search import search_knowledge
from app.retrieval.terms import normalized, plan_query
from app.worker.pipeline import process_ingestion_job

EQUIVALENTS = [
    ("ＡＢＣ１２３", "abc123"),
    ("ＡＢＣ１２３", "ＡＢＣ１２３"),
    ("１２３４", "1234"),
    ("ｶﾀｶﾅ", "カタカナ"),
    ("ｶﾀｶﾅ", "ｶﾀｶﾅ"),
    ("ﬃ", "ffi"),
    ("Ⅳ", "iv"),
    ("①", "1"),
    ("㎏", "kg"),
    ("Straße", "strasse"),
    ("％", "%"),
    ("＿", "_"),
    ("＼", "\\"),
]


def no_models(**overrides):
    return Settings(
        _env_file=None,
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        embedding_base_url="",
        embedding_api_key="",
        embedding_model="",
        **overrides,
    )


def upload_and_parse(client, factory, kb_id, filename, body):
    uploaded = client.post(
        f"/api/knowledge-bases/{kb_id}/uploads",
        files=[("files", (filename, body.encode("utf-8"), "text/plain"))],
    )
    assert uploaded.status_code == 200, uploaded.text
    result = uploaded.json()
    assert result["items"][0]["status"] == "queued"
    process_ingestion_job(
        result["jobs"][0]["id"],
        factory,
        no_models(database_url="sqlite://", upload_root=get_settings().upload_root),
    )
    return result["items"][0]["document"]["id"]


@pytest.mark.xfail(strict=True, reason="Known raw-text SQL admission gap; see docs/todo/retrieval-unicode-normalization.md")
@pytest.mark.parametrize("raw, query", EQUIVALENTS)
def test_uploaded_unicode_equivalent_body_reaches_keyword_candidates(client, factory, raw, query):
    assert normalized(raw) == normalized(query)
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    doc_id = upload_and_parse(client, factory, kb_id, "opaque.txt", raw)
    with factory() as db:
        rows = list(
            db.execute(
                select(DocumentChunk, Document)
                .join(Document, Document.id == DocumentChunk.document_id)
                .where(Document.id == doc_id)
            )
        )
        assert len(rows) == 1 and rows[0][0].content == raw
        assert lexical_scores(rows, plan_query(query))[rows[0][0].id] > 0
    result = client.post("/api/search", json={"query": query, "kb_ids": [kb_id], "mode": "keyword"})
    assert result.status_code == 200, result.text
    assert [item["document_id"] for item in result.json()["items"]] == [doc_id], result.json()


@pytest.mark.xfail(strict=True, reason="Known raw-title SQL admission gap; see docs/todo/retrieval-unicode-normalization.md")
@pytest.mark.parametrize("raw, query", [("ＡＢＣ１２３", "abc123"), ("ｶﾀｶﾅ", "カタカナ"), ("ﬃ", "ffi")])
def test_uploaded_unicode_equivalent_filename_reaches_keyword_candidates(client, factory, raw, query):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    doc_id = upload_and_parse(client, factory, kb_id, raw + ".txt", "neutral payload")
    result = client.post("/api/search", json={"query": query, "kb_ids": [kb_id], "mode": "keyword"})
    assert result.status_code == 200
    assert [item["document_id"] for item in result.json()["items"]] == [doc_id], result.json()


@pytest.mark.parametrize("raw, query", [("ABC123", "ＡＢＣ１２３"), ("カタカナ", "ｶﾀｶﾅ")])
def test_normalized_source_already_accepts_compatibility_form_queries(client, factory, raw, query):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    doc_id = upload_and_parse(client, factory, kb_id, "opaque.txt", raw)
    found = client.post("/api/search", json={"query": query, "kb_ids": [kb_id], "mode": "keyword"}).json()
    assert [item["document_id"] for item in found["items"]] == [doc_id]


@pytest.mark.parametrize(
    "literal, near_miss",
    [("%", "ordinary text"), ("_", "X"), ("\\", "/"), ("100%_complete", "100XXcomplete")],
)
def test_ascii_like_symbols_stay_literal_through_real_upload_and_search(client, factory, literal, near_miss):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    target = upload_and_parse(client, factory, kb_id, "opaque.txt", literal)
    upload_and_parse(client, factory, kb_id, "other.txt", near_miss)
    found = client.post("/api/search", json={"query": literal, "kb_ids": [kb_id], "mode": "keyword"}).json()
    assert [item["document_id"] for item in found["items"]] == [target]


@pytest.mark.skipif(not os.getenv("PG_INGESTION_TEST_URL"), reason="Set isolated PG_INGESTION_TEST_URL")
@pytest.mark.xfail(strict=True, reason="Known PG raw-text SQL admission gap; see docs/todo/retrieval-unicode-normalization.md")
@pytest.mark.parametrize("raw, query", EQUIVALENTS)
def test_postgres_unicode_equivalents_reach_the_same_product_search(pg_factory, raw, query):
    with pg_factory() as db:
        actor = User(email=f"unicode-admission-{new_id()}@example.test", display_name="Unicode准入专项")
        db.add(actor)
        db.flush()
        kb = KnowledgeBase(owner_id=actor.id, name="Unicode隔离测试")
        db.add(kb)
        db.flush()
        db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
        doc = Document(
            kb_id=kb.id,
            owner_id=actor.id,
            display_name="opaque.txt",
            original_filename="opaque.txt",
            ext="txt",
            mime_type="text/plain",
            sha256="0",
            size_bytes=len(raw.encode("utf-8")),
            storage_key=f"unicode-admission/{new_id()}/original",
            parse_status="ready",
        )
        db.add(doc)
        db.flush()
        section = DocumentSection(document_id=doc.id, kb_id=kb.id, plain_text=raw)
        db.add(section)
        db.flush()
        chunk = DocumentChunk(
            kb_id=kb.id,
            document_id=doc.id,
            section_id=section.id,
            chunk_index=0,
            content=raw,
            token_count=len(raw),
            source_start=0,
            source_end=len(raw),
            anchors={},
        )
        db.add(chunk)
        db.commit()
        assert lexical_scores([(chunk, doc)], plan_query(query))[chunk.id] > 0
        found = search_knowledge(
            db, actor, {"query": query, "kb_ids": [kb.id], "mode": "keyword"}, no_models()
        )
        assert [item["document_id"] for item in found["items"]] == [doc.id], found
