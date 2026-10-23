"""Opt-in PostgreSQL interleavings for reviewed metadata deletion, no model I/O."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import event, select
from test_ingestion_postgres import pg_factory as pg_factory

from app.agent.executor import execute_plan, persist_plan, undo_run
from app.agent.plans import PlanDraft
from app.core.errors import AppError
from app.db.models import (
    AgentRun,
    Document,
    DocumentTag,
    KnowledgeBase,
    KnowledgeBaseMember,
    Tag,
    User,
    new_id,
)
from app.services import library

pytestmark = pytest.mark.skipif(not os.getenv("PG_INGESTION_TEST_URL"), reason="Set isolated PG_INGESTION_TEST_URL")


def create_plan(factory, linked=False):
    with factory() as db:
        actor = User(email=f"delete-{new_id()}@example.test", display_name="标签删除隔离测试")
        db.add(actor)
        db.flush()
        kb = KnowledgeBase(owner_id=actor.id, name="删除事务测试")
        db.add(kb)
        db.flush()
        db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
        doc = Document(kb_id=kb.id, owner_id=actor.id, display_name="资料.md", original_filename="资料.md",
            ext="md", mime_type="text/markdown", sha256="c" * 64, size_bytes=10, storage_key=f"tests/{new_id()}/original")
        tag = Tag(kb_id=kb.id, name="废弃主题", normalized_name="废弃主题")
        db.add_all([doc, tag])
        db.flush()
        if linked:
            library.set_document_tags(db, doc, [tag.id])
        run = AgentRun(kb_id=kb.id, actor_id=actor.id, thread_id=new_id(), goal="删除废弃标签")
        db.add(run)
        db.flush()
        plan = persist_plan(db, actor, run, PlanDraft(summary="待审批标签删除", operations=[{
            "operation_id": "delete", "type": "delete_tags", "target_ids": [tag.id], "params": {}, "description": "删除废弃标签"}]))
        db.commit()
        return {"actor": actor.id, "doc": doc.id, "tag": tag.id, "kb": kb.id, "plan": plan.id, "run": run.id}


def test_tag_metadata_and_relations_restore_with_original_id_under_real_foreign_keys(pg_factory):
    ids = create_plan(pg_factory, linked=True)
    with pg_factory() as db:
        actor = db.get(User, ids["actor"])
        execute_plan(db, actor, ids["plan"], 1, True)
        db.commit()
        assert db.get(Tag, ids["tag"]) is None
        undo_run(db, actor, ids["run"])
        db.commit()
        assert db.get(Tag, ids["tag"]).name == "废弃主题"
        assert db.scalar(select(DocumentTag.document_id).where(DocumentTag.tag_id == ids["tag"])) == ids["doc"]


def test_association_committed_while_approval_waits_for_namespace_invalidates_plan(pg_factory):
    ids = create_plan(pg_factory)
    attempted = threading.Event()
    with pg_factory() as writer:
        actor = writer.get(User, ids["actor"])
        library.lock_kb_namespace(writer, actor, ids["kb"])

        def approve():
            with pg_factory() as db:
                def before_sql(_connection, _cursor, statement, _parameters, _context, _many):
                    if "knowledge_bases" in statement and "FOR UPDATE" in statement:
                        attempted.set()
                event.listen(db.connection(), "before_cursor_execute", before_sql)
                try:
                    execute_plan(db, db.get(User, ids["actor"]), ids["plan"], 1, True)
                    db.commit()
                    return "executed"
                except AppError as error:
                    db.rollback()
                    return error.code

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(approve)
            assert attempted.wait(5), "approval must reach and wait at the namespace lock"
            library.update_document(writer, actor, ids["doc"], {"tag_ids": [ids["tag"]], "tag_mode": "add"})
            writer.commit()
            assert pending.result(timeout=10) == "version_conflict"
    with pg_factory() as db:
        assert db.get(Tag, ids["tag"])
        assert db.scalar(select(DocumentTag.document_id).where(DocumentTag.tag_id == ids["tag"])) == ids["doc"]


def test_tag_undo_checks_fresh_document_after_waiting_for_namespace(pg_factory):
    ids = create_plan(pg_factory)
    with pg_factory() as db:
        actor = db.get(User, ids["actor"])
        library.update_document(db, actor, ids["doc"], {"tag_ids": [ids["tag"]]})
        # The first plan's empty membership is stale: a new reviewed snapshot is required.
        run = AgentRun(kb_id=ids["kb"], actor_id=actor.id, thread_id=new_id(), goal="删除废弃标签")
        db.add(run)
        db.flush()
        plan = persist_plan(db, actor, run, PlanDraft(summary="新快照", operations=[{
            "operation_id": "delete", "type": "delete_tags", "target_ids": [ids["tag"]], "params": {}, "description": "删除标签和关联"}]))
        execute_plan(db, actor, plan.id, 1, True)
        db.commit()
        run_id = run.id
    attempted = threading.Event()
    with pg_factory() as writer:
        actor = writer.get(User, ids["actor"])
        library.lock_kb_namespace(writer, actor, ids["kb"])

        def undo():
            with pg_factory() as db:
                def before_sql(_connection, _cursor, statement, _parameters, _context, _many):
                    if "knowledge_bases" in statement and "FOR UPDATE" in statement:
                        attempted.set()
                event.listen(db.connection(), "before_cursor_execute", before_sql)
                try:
                    undo_run(db, db.get(User, ids["actor"]), run_id)
                    db.commit()
                    return "undone"
                except AppError as error:
                    db.rollback()
                    return error.code

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(undo)
            assert attempted.wait(5)
            library.update_document(writer, actor, ids["doc"], {"display_name": "后续人工修改.md"})
            writer.commit()
            assert pending.result(timeout=10) == "undo_conflict"
    with pg_factory() as db:
        assert db.get(Tag, ids["tag"]) is None
        assert db.get(Document, ids["doc"]).display_name == "后续人工修改.md"
