"""Synthetic multi-chunk corpora shared by SQLite and opt-in PostgreSQL checks."""

import random
from uuid import uuid4

from sqlalchemy import insert

from app.core.config import Settings
from app.db.models import Document, DocumentChunk, DocumentSection, KnowledgeBase, KnowledgeBaseMember, User


def offline_settings():
    return Settings(_env_file=None, embedding_base_url="", embedding_api_key="", embedding_model="",
                    llm_base_url="", llm_api_key="", llm_model="", embedding_dimension=3)


def seed_retrieval_corpus(db, documents=25, chunks=20, *, target=None, text_factory=None):
    suffix, rng = uuid4().hex[:12], random.Random(0)
    actor = User(email=f"retrieval-pagination-{suffix}@example.test", display_name="隔离分页专项")
    db.add(actor)
    db.flush()
    kb = KnowledgeBase(owner_id=actor.id, name="多片段检索专项")
    db.add(kb)
    db.flush()
    db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
    db.flush()
    doc_rows, section_rows, chunk_rows, ids = [], [], [], {}
    for doc in range(documents):
        doc_id = f"{doc:08x}-0000-4000-8000-{suffix}"
        doc_rows.append({"id": doc_id, "kb_id": kb.id, "owner_id": actor.id, "display_name": f"archive-{doc}",
                         "original_filename": f"{doc}.txt", "ext": "txt", "mime_type": "text/plain",
                         "sha256": doc_id, "storage_key": f"tests/{suffix}/{doc}", "size_bytes": 100,
                         "parse_status": "ready", "index_status": "ready"})
        for chunk in range(chunks):
            key = f"{doc:08x}-{chunk:04x}-4000-8000-{suffix}"
            ids[doc, chunk] = key
            if text_factory:
                content = text_factory(doc, chunk)
            elif target:
                content = ("alpha :: beta :: gamma :: " * 4 + "Verified launch date is 2031-03-27."
                           if (doc, chunk) == target else
                           "alpha :: beta :: gamma :: " + "ordinary background paragraph. " * 50)
            else:
                tokens = sum(([term] * rng.randint(1, 6) for term in ("alpha", "beta", "gamma")), [])
                tokens += ["ordinary"] * rng.randint(0, 30)
                rng.shuffle(tokens)
                content = " :: ".join(tokens) + f" doc{doc}chunk{chunk}"
            section_rows.append({"id": key, "kb_id": kb.id, "document_id": doc_id, "plain_text": content,
                                 "order": chunk, "anchors": {"paragraph": chunk + 1}})
            chunk_rows.append({"id": key, "kb_id": kb.id, "document_id": doc_id, "section_id": key,
                               "chunk_index": chunk, "content": content, "token_count": len(content.split()),
                               "anchors": {"paragraph": chunk + 1}})
    db.execute(insert(Document), doc_rows)
    db.execute(insert(DocumentSection), section_rows)
    db.execute(insert(DocumentChunk), chunk_rows)
    db.flush()
    return actor, kb, ids
