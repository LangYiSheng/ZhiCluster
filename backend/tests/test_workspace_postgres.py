"""Optional real pgvector profile isolation, confined to a dedicated test schema."""

import json
import os
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app.ai.gateway import ModelGateway
from app.api import workflows
from app.core.config import Settings
from app.db.models import (
    Base,
    ChunkEmbedding,
    ClassificationSuggestion,
    EmbeddingProfile,
    KnowledgeBase,
    KnowledgeBaseMember,
)
from app.db.seed import seed
from app.db.session import get_db
from app.retrieval.search import search_knowledge
from app.services.knowledge_settings import settings_for_knowledge_base
from app.services.permissions import get_actor
from app.worker.pipeline import process_ingestion_job
from tests.test_workspace_personalization import source

TEST_URL = os.getenv("PG_WORKSPACE_TEST_URL", "")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="Set isolated PG_WORKSPACE_TEST_URL")


def test_existing_conversation_ownership_and_kb_defaults_are_backfilled():
    url = make_url(TEST_URL)
    assert url.database == "zhicluster_workspace_test" and not url.query
    schema = "workspace_migration_" + uuid4().hex
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(text(f'SET LOCAL search_path TO "{schema}", public'))
            connection.execute(text("CREATE TABLE knowledge_bases (id varchar(36) PRIMARY KEY)"))
            connection.execute(text("CREATE TABLE conversations (id varchar(36) PRIMARY KEY, scope json NOT NULL)"))
            connection.execute(text("INSERT INTO knowledge_bases (id) VALUES ('legacy-library')"))
            connection.execute(text("INSERT INTO conversations (id, scope) VALUES ('legacy-chat', :scope)"),
                {"scope": json.dumps({"kb_ids": ["legacy-library", "another-reference"]})})
            migration_path = Path(__file__).parents[1] / "alembic/versions/06_workspace_personalization.py"
            spec = spec_from_file_location("workspace_migration_test", migration_path)
            migration = module_from_spec(spec)
            spec.loader.exec_module(migration)
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
            assert connection.execute(text("SELECT icon, color, embedding_model, embedding_dimension FROM knowledge_bases")).one() == ("folder", "#55a995", None, None)
            assert connection.scalar(text("SELECT kb_id FROM conversations")) == "legacy-library"
            migration.downgrade()
    finally:
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        engine.dispose()


def test_postgres_mixed_dimension_profiles_use_each_bound_query_model(monkeypatch):
    url = make_url(TEST_URL)
    assert url.database == "zhicluster_workspace_test", "Only the dedicated workspace test database is allowed"
    assert not url.query, "Connection query overrides are forbidden"
    schema = "workspace_test_" + uuid4().hex
    admin = create_engine(url)
    engine = None
    try:
        with admin.begin() as connection:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema},public"})
        Base.metadata.create_all(engine)
        factory = sessionmaker(engine, expire_on_commit=False)
        settings = Settings(_env_file=None, embedding_base_url="https://controlled.invalid/v1", embedding_api_key="fake",
            embedding_model="global-unused", embedding_dimension=7)
        monkeypatch.setattr(workflows, "get_settings", lambda: settings)
        sent_models = []

        def respond(request):
            payload = json.loads(request.content)
            model = payload["model"]
            sent_models.append(model)
            dimension = {"bound-two": 2, "bound-three": 3}[model]
            return httpx.Response(200, json={"data": [{"index": index, "embedding": [1.0] + [0.0] * (dimension - 1)}
                for index, _ in enumerate(payload["input"])]})

        original_init = ModelGateway.__init__

        def initialize(self, settings, **kwargs):
            original_init(self, settings, transport=httpx.MockTransport(respond))

        monkeypatch.setattr(ModelGateway, "__init__", initialize)
        with factory() as db:
            seed(db)
            actor = get_actor(db)
            ids, chunk_ids = [], []
            for model, dimension in (("bound-two", 2), ("bound-three", 3)):
                kb = KnowledgeBase(owner_id=actor.id, name=model, embedding_model=model, embedding_dimension=dimension)
                db.add(kb)
                db.flush()
                db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
                _, chunk = source(db, kb.id, "独立语义证据")
                configured = settings_for_knowledge_base(settings, kb)
                profile = EmbeddingProfile(fingerprint=ModelGateway(configured).profile_fingerprint, model_name=model, dimension=dimension)
                db.add(profile)
                db.flush()
                db.add(ChunkEmbedding(kb_id=kb.id, chunk_id=chunk.id, profile_id=profile.id,
                    embedding=[1.0] + [0.0] * (dimension - 1)))
                ids.append(kb.id)
                chunk_ids.append(chunk.id)
            db.commit()
            found = search_knowledge(db, actor, {"query": "nonlexical semantic evidence", "kb_ids": ids, "mode": "hybrid"}, settings)
            assert found["mode"] == "hybrid"
            assert {item["chunk_id"] for item in found["items"]} == set(chunk_ids)
            assert set(sent_models) == {"bound-two", "bound-three"} and "global-unused" not in sent_models
            assert len(list(db.scalars(select(EmbeddingProfile)))) == 2
            assert workflows.statistics(db=db)["indexed_documents"] == 2
            assert workflows.statistics(kb_id=ids[0], db=db)["indexed_documents"] == 1
            first = db.get(KnowledgeBase, ids[0])
            first.embedding_model = "new-profile-without-vectors"
            db.commit()
            assert workflows.statistics(db=db)["indexed_documents"] == 1
            assert workflows.statistics(kb_id=ids[0], db=db)["indexed_documents"] == 0
    finally:
        if engine:
            engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin.dispose()


def test_long_embedding_and_chat_model_ids_survive_pg_migration_ingestion_query_and_statistics(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from app.api import library
    from app.main import app
    from app.retrieval import search as retrieval

    url = make_url(TEST_URL)
    assert url.database == "zhicluster_workspace_test" and not url.query
    schema = "model_ids_" + uuid4().hex
    admin = create_engine(url)
    engine = None
    previous_override = app.dependency_overrides.get(get_db)
    try:
        with admin.begin() as connection:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema},public"})
        Base.metadata.create_all(engine)
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE embedding_profiles ALTER COLUMN model_name TYPE varchar(200)"))
            connection.execute(text("ALTER TABLE classification_suggestions ALTER COLUMN model TYPE varchar(200)"))
        factory = sessionmaker(engine, expire_on_commit=False)
        with factory() as db:
            seed(db)
            base = db.scalar(select(KnowledgeBase))
            legacy_doc, _ = source(db, base.id, "原有资料")
            legacy_profile = EmbeddingProfile(fingerprint="legacy-fingerprint", model_name="legacy/embedding:v1", dimension=2)
            legacy_suggestion = ClassificationSuggestion(document_id=legacy_doc.id, kb_id=base.id,
                document_version=1, model="legacy/chat:v1", payload={"reason": "preserve"})
            db.add_all([legacy_profile, legacy_suggestion])
            db.commit()
            legacy_profile_id, legacy_suggestion_id = legacy_profile.id, legacy_suggestion.id
        with engine.begin() as connection:
            path = Path(__file__).parents[1] / "alembic/versions/07_model_identifiers.py"
            spec = spec_from_file_location("model_identifiers_pg_test", path)
            migration = module_from_spec(spec)
            spec.loader.exec_module(migration)
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
            for table, column in (("embedding_profiles", "model_name"), ("classification_suggestions", "model")):
                actual = next(item for item in inspect(connection).get_columns(table, schema=schema) if item["name"] == column)
                assert actual["type"].length == 512
        with factory() as db:
            assert db.get(EmbeddingProfile, legacy_profile_id).model_name == "legacy/embedding:v1"
            assert db.get(ClassificationSuggestion, legacy_suggestion_id).model == "legacy/chat:v1"
            assert db.get(ClassificationSuggestion, legacy_suggestion_id).payload == {"reason": "preserve"}

        long_embedding = "vendor/" + "embedding-v1.2-" * 18 + ":latest"
        long_chat = "org/" + "chat-v1.2-" * 24 + ":latest"
        assert len(long_embedding) > 211 and len(long_chat) > 211
        settings = Settings(_env_file=None, upload_root=tmp_path / "uploads", embedding_base_url="https://controlled.invalid/v1",
            embedding_api_key="fake", embedding_model="global-unused", embedding_dimension=7,
            llm_base_url="https://controlled.invalid/v1", llm_api_key="fake", llm_model=long_chat)
        monkeypatch.setattr(library, "get_settings", lambda: settings)
        monkeypatch.setattr(workflows, "get_settings", lambda: settings)
        monkeypatch.setattr(retrieval, "get_settings", lambda: settings)
        requested_embeddings, requested_chats = [], []

        def respond(request):
            payload = json.loads(request.content)
            if request.url.path.endswith("/embeddings"):
                requested_embeddings.append(payload["model"])
                assert payload["model"] == long_embedding
                return httpx.Response(200, json={"data": [{"index": index, "embedding": [1.0, 0.0]}
                    for index, _ in enumerate(payload["input"])]})
            requested_chats.append(payload["model"])
            assert payload["model"] == long_chat
            outcome = {"summary": {"short_summary": "申请名额28人。", "detailed_summary": "课程申请名额为28人。",
                "keywords": ["课程"], "main_topics": ["申请"]},
                "classification": {"existing_folder_id": None, "existing_tag_ids": [], "new_tag_names": [],
                    "short_summary": "课程申请资料", "reason": "保留在当前目录"}}
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(outcome, ensure_ascii=False)}}]})

        original_init = ModelGateway.__init__

        def initialize(self, settings, **kwargs):
            kwargs.pop("transport", None)
            original_init(self, settings, transport=httpx.MockTransport(respond), **kwargs)

        monkeypatch.setattr(ModelGateway, "__init__", initialize)

        def pg_db():
            with factory() as db:
                try:
                    yield db
                    db.commit()
                except Exception:
                    db.rollback()
                    raise

        app.dependency_overrides[get_db] = pg_db
        with TestClient(app) as client:
            created = client.post("/api/knowledge-bases", json={"name": "长模型验收", "embedding_model": long_embedding,
                "embedding_dimension": 2})
            assert created.status_code == 201, created.text
            assert created.json()["embedding_model"] == long_embedding
            kb_id = created.json()["id"]
            uploaded = client.post(f"/api/knowledge-bases/{kb_id}/uploads", files={"files":
                ("proof.txt", "课程申请名额为28人。".encode(), "text/plain")}).json()
            document_id = uploaded["items"][0]["document"]["id"]
            process_ingestion_job(uploaded["jobs"][0]["id"], factory, settings)
            document = client.get(f"/api/documents/{document_id}").json()
            assert document["index_status"] == document["classification_status"] == "ready"
            found = client.post("/api/search", json={"query": "nonlexical semantic evidence", "kb_ids": [kb_id], "mode": "hybrid"})
            assert found.status_code == 200 and found.json()["mode"] == "hybrid", found.text
            assert {item["document_id"] for item in found.json()["items"]} == {document_id}
            assert client.get("/api/settings/statistics", params={"kb_id": kb_id}).json()["indexed_documents"] == 1
            assert client.get(f"/api/knowledge-bases/{kb_id}").json()["embedding_model"] == long_embedding
        assert len(requested_embeddings) >= 2 and requested_chats
        with factory() as db:
            assert db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.model_name == long_embedding))
            assert db.scalar(select(ClassificationSuggestion.model).where(ClassificationSuggestion.document_id == document_id)) == long_chat
    finally:
        if previous_override is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous_override
        if engine:
            engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin.dispose()
