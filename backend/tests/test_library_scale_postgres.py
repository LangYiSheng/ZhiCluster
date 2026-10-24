"""Opt-in metadata batching/interleavings on a dedicated PostgreSQL test DB."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import event, select
from test_ingestion_postgres import pg_factory as pg_factory

from app.api import library as api
from app.core.errors import AppError
from app.db.models import (
    AuditLog,
    Document,
    DocumentTag,
    Folder,
    KnowledgeBase,
    KnowledgeBaseMember,
    Tag,
    User,
    new_id,
)
from app.services import library

pytestmark = pytest.mark.skipif(not os.getenv("PG_INGESTION_TEST_URL"), reason="Set isolated PG_INGESTION_TEST_URL")


def seed_tree(factory, count=40):
    with factory() as db:
        actor = User(email=f"folder-scale-{new_id()}@example.test", display_name="文件夹规模专项")
        db.add(actor)
        db.flush()
        kb = KnowledgeBase(owner_id=actor.id, name="隔离目录专项")
        db.add(kb)
        db.flush()
        db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
        root = library.create_folder(db, actor, kb.id, {"name": "待删除"})
        child = library.create_folder(db, actor, kb.id, {"name": "子目录", "parent_id": root.id})
        outside = library.create_folder(db, actor, kb.id, {"name": "保留"})
        tag = Tag(kb_id=kb.id, name="标记", normalized_name="标记")
        db.add(tag)
        docs = [Document(kb_id=kb.id, owner_id=actor.id, folder_id=child.id, display_name=f"{n}.txt",
            original_filename=f"{n}.txt", mime_type="text/plain", ext="txt", sha256=str(n), size_bytes=1,
            storage_key=f"tests/{new_id()}/original") for n in range(count)]
        db.add_all(docs)
        db.flush()
        db.add_all(DocumentTag(document_id=doc.id, tag_id=tag.id, kb_id=kb.id) for doc in docs)
        db.commit()
        return {"actor": actor.id, "kb": kb.id, "root": root.id, "child": child.id, "outside": outside.id,
            "documents": [doc.id for doc in docs], "tag": tag.id}


def test_folder_delete_after_namespace_wait_sees_committed_document_move(pg_factory, monkeypatch):
    ids = seed_tree(pg_factory)
    monkeypatch.setattr(api, "get_actor", lambda db: db.get(User, ids["actor"]))
    waiting = threading.Event()

    def remove_tree():
        with pg_factory() as db:
            def observe(_connection, _cursor, statement, _parameters, _context, _many):
                if "knowledge_bases" in statement and "FOR UPDATE" in statement:
                    waiting.set()
            event.listen(db.connection(), "before_cursor_execute", observe)
            result = api.delete_folder(ids["root"], db=db)
            db.commit()
            return result

    with pg_factory() as writer:
        actor = writer.get(User, ids["actor"])
        library.lock_kb_namespace(writer, actor, ids["kb"])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(remove_tree)
            assert waiting.wait(5), "deletion must reach the namespace lock"
            library.update_document(writer, actor, ids["documents"][0], {"folder_id": ids["outside"]})
            writer.commit()
            assert pending.result(timeout=10) == {"status": "trashed", "folders": 2}
    with pg_factory() as db:
        escaped = db.get(Document, ids["documents"][0])
        assert escaped.folder_id == ids["outside"] and escaped.deleted_at is None
        remaining = list(db.scalars(select(Document).where(Document.id.in_(ids["documents"][1:]))))
        assert len(remaining) == 39 and all(doc.deleted_at and doc.version == 2 for doc in remaining)
        assert db.get(Folder, ids["outside"]).deleted_at is None
        assert len(list(db.scalars(select(DocumentTag).where(DocumentTag.kb_id == ids["kb"])))) == 40
        logs = list(db.scalars(select(AuditLog).where(AuditLog.kb_id == ids["kb"], AuditLog.action == "update_document")))
        deleted_logs = [log for log in logs if log.after["deleted_at"]]
        assert len(deleted_logs) == 39
        assert all(log.before["tag_ids"] == log.after["tag_ids"] == [ids["tag"]] for log in deleted_logs)


def test_document_restore_waiting_for_tree_deletion_rejects_deleted_parent(pg_factory, monkeypatch):
    ids = seed_tree(pg_factory, count=1)
    monkeypatch.setattr(api, "get_actor", lambda db: db.get(User, ids["actor"]))
    waiting = threading.Event()

    def restore_document():
        with pg_factory() as db:
            def observe(_connection, _cursor, statement, _parameters, _context, _many):
                if "knowledge_bases" in statement and "FOR UPDATE" in statement:
                    waiting.set()
            event.listen(db.connection(), "before_cursor_execute", observe)
            try:
                library.update_document(db, db.get(User, ids["actor"]), ids["documents"][0], {"deleted_at": None})
                db.commit()
                return "restored"
            except AppError as error:
                db.rollback()
                return error.code

    with pg_factory() as writer:
        api.delete_folder(ids["root"], db=writer)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(restore_document)
            assert waiting.wait(5), "restore must wait for namespace deletion transaction"
            writer.commit()
            assert pending.result(timeout=10) == "invalid_folder"
    with pg_factory() as db:
        assert db.get(Document, ids["documents"][0]).deleted_at is not None
        assert db.get(Document, ids["documents"][0]).version == 2
