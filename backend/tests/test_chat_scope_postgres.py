"""Actual PostgreSQL intersection and citation freshness, in a disposable schema."""

import os
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.core.errors import AppError
from app.db.models import Base, DocumentTag, Folder, KnowledgeBase, Tag
from app.db.seed import seed
from app.retrieval.chat_tools import current_hits
from app.retrieval.search import search_knowledge
from app.retrieval.tool_scope import ReadOnlyScope
from app.services.permissions import get_actor
from tests.test_workspace_personalization import source

TEST_URL = os.getenv("PG_CHAT_SCOPE_TEST_URL", "")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="Set isolated PG_CHAT_SCOPE_TEST_URL")


def test_postgres_narrowed_folder_and_tags_intersect_and_hits_expire_after_changes():
    url = make_url(TEST_URL)
    assert url.database == "zhicluster_workspace_test" and not url.query
    schema = "chat_scope_" + uuid4().hex
    admin, engine = create_engine(url), None
    try:
        with admin.begin() as connection:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema},public"})
        Base.metadata.create_all(engine)
        factory = sessionmaker(engine, expire_on_commit=False)
        with factory() as db:
            seed(db)
            actor = get_actor(db)
            kb = db.scalar(select(KnowledgeBase))
            parent = Folder(kb_id=kb.id, name="Allowed parent")
            outside = Folder(kb_id=kb.id, name="Outside selected directory")
            db.add_all([parent, outside])
            db.flush()
            child = Folder(kb_id=kb.id, parent_id=parent.id, name="Child course")
            tags = [Tag(kb_id=kb.id, name=name, normalized_name=name.lower()) for name in ("A", "B", "C")]
            db.add_all([child, *tags])
            db.flush()
            documents = []
            for index, (folder, selected_tags) in enumerate([
                (child, [tags[0], tags[2]]),
                (child, [tags[2]]),
                (parent, [tags[0], tags[2]]),
                (outside, [tags[0], tags[2]]),
                (child, [tags[1]]),
            ]):
                doc, _ = source(db, kb.id, "scopeproof evidence " + str(index), name=f"proof-{index}.txt")
                doc.folder_id = folder.id
                for tag in selected_tags:
                    db.add(DocumentTag(kb_id=kb.id, document_id=doc.id, tag_id=tag.id))
                documents.append(doc)
            db.commit()
            fixed = {"kb_ids": [kb.id], "folder_ids": [parent.id], "include_descendants": True,
                     "tag_ids": [tags[0].id, tags[1].id], "tag_match": "any"}
            scoped = ReadOnlyScope(db, actor, fixed)
            folders = scoped.metadata("folders")["items"]
            assert {item["id"] for item in folders} == {parent.id, child.id}
            settings = Settings(_env_file=None, embedding_api_key="", llm_api_key="")
            direct_only = scoped.narrow({"include_descendants": False})
            direct_result = search_knowledge(db, actor, {**direct_only, "query": "scopeproof", "mode": "keyword"}, settings)
            assert {hit["document_id"] for hit in direct_result["items"]} == {documents[2].id}
            all_tags = scoped.narrow({"tag_match": "all"})
            all_result = search_knowledge(db, actor, {**all_tags, "query": "scopeproof", "mode": "keyword"}, settings)
            assert all_result["items"] == []
            with pytest.raises(AppError, match="超出当前对话范围"):
                scoped.narrow({"folder_ids": [outside.id]})
            request = scoped.narrow({"folder_ids": [child.id], "include_descendants": False,
                                     "tag_ids": [tags[2].id], "tag_match": "all"})
            result = search_knowledge(db, actor, {**request, "query": "scopeproof", "mode": "keyword"},
                                      settings)
            assert {hit["document_id"] for hit in result["items"]} == {documents[0].id}
            hits = [{**hit, "_search_scopes": [request]} for hit in result["items"]]
            assert len(current_hits(db, actor, fixed, hits)) == 1
            # The document remains in the broad parent scope, but moved out of
            # the model's selected child. Its previous citation must disappear.
            documents[0].folder_id = parent.id
            documents[0].version += 1
            db.commit()
            assert current_hits(db, actor, fixed, hits) == []
            documents[0].folder_id = child.id
            db.commit()
            db.execute(delete(DocumentTag).where(DocumentTag.document_id == documents[0].id,
                                                 DocumentTag.tag_id == tags[2].id))
            db.commit()
            assert current_hits(db, actor, fixed, hits) == []
    finally:
        if engine is not None:
            engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin.dispose()
