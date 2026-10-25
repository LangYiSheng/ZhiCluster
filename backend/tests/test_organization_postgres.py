"""Real PostgreSQL metadata transactions inside a disposable, dedicated schema."""

import os
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from test_organization_modes import (
    test_cleanup_never_deletes_nonempty_or_outside_scope_directories as guarded_cleanup,
)
from test_organization_modes import (
    test_full_library_scope_also_proposes_preexisting_empty_tree_without_any_moves as cleanup_existing,
)
from test_organization_modes import (
    test_merge_cleans_only_moved_source_tree_and_undo_restores_parents_before_documents as merge_and_undo,
)

from app.db.models import Base, Document, KnowledgeBase, KnowledgeBaseMember
from app.db.seed import seed
from app.services.permissions import get_actor

TEST_URL = os.getenv("PG_ORGANIZATION_TEST_URL", "")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="Set isolated PG_ORGANIZATION_TEST_URL")


@pytest.fixture
def pg_review_workspace():
    url = make_url(TEST_URL)
    assert url.database == "zhicluster_workspace_test" and not url.query
    schema = "review_organization_" + uuid4().hex
    admin = create_engine(url)
    engine = None
    try:
        with admin.begin() as connection:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema},public"})
        Base.metadata.create_all(engine)
        sessions = sessionmaker(engine, expire_on_commit=False)
        with sessions() as db:
            seed(db)
            actor = get_actor(db)
            kb = KnowledgeBase(owner_id=actor.id, name="独立整理事务验证")
            db.add(kb)
            db.flush()
            db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
            doc = Document(kb_id=kb.id, owner_id=actor.id, display_name="原始.md", original_filename="原始.md",
                mime_type="text/markdown", ext="md", sha256="a" * 64, size_bytes=10,
                storage_key="private/test/original", parse_status="ready")
            db.add(doc)
            db.commit()
            yield db, actor, kb, doc
    finally:
        if engine:
            engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin.dispose()


def test_postgres_merge_soft_cleanup_and_complete_undo(pg_review_workspace):
    merge_and_undo(pg_review_workspace)


def test_postgres_existing_empty_tree_cleanup_without_moving_documents(pg_review_workspace):
    cleanup_existing(pg_review_workspace)


@pytest.mark.parametrize("obstacle", ["new_document", "new_child", "recycled_descendant"])
def test_postgres_cleanup_rechecks_live_contents(pg_review_workspace, obstacle):
    guarded_cleanup(pg_review_workspace, obstacle)
