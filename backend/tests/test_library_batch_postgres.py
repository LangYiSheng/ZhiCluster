"""Opt-in batch metadata races on the dedicated PostgreSQL test database."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import delete, event, select
from test_ingestion_postgres import pg_factory as pg_factory
from test_library_scale_postgres import seed_tree

from app.core.errors import AppError
from app.db.models import AuditLog, Document, DocumentTag, Folder, Tag, User, utcnow
from app.services import library

pytestmark = pytest.mark.skipif(not os.getenv("PG_INGESTION_TEST_URL"), reason="Set isolated PG_INGESTION_TEST_URL")


@pytest.mark.parametrize("change", ["move_and_tags", "delete_folder", "delete_tag", "delete_document", "restore_parent"])
def test_batch_after_namespace_wait_revalidates_documents_parents_and_tags(pg_factory, change):
    ids = seed_tree(pg_factory, count=3)
    with pg_factory() as db:
        b, c = [Tag(kb_id=ids["kb"], name=name, normalized_name=name) for name in ("并发标签", "批量标签")]
        db.add_all([b, c])
        if change == "restore_parent":
            for doc in db.scalars(select(Document).where(Document.id.in_(ids["documents"]))):
                doc.deleted_at = utcnow()
        db.commit()
        ids.update({"tag_b": b.id, "tag_c": c.id})
    data = ({"folder_id": ids["outside"]} if change == "delete_folder" else {"deleted_at": None}
        if change == "restore_parent" else {"tag_ids": [ids["tag_c"]], "tag_mode": "add"})
    waiting = threading.Event()

    def batch():
        with pg_factory() as db:
            # Keep stale identity-map entries alive across the namespace wait.
            cached_documents = list(db.scalars(select(Document).where(Document.id.in_(ids["documents"]))))
            cached_folders = list(db.scalars(select(Folder).where(Folder.kb_id == ids["kb"])))
            cached_tag = db.get(Tag, ids["tag_c"])
            assert len(cached_documents) == 3 and len(cached_folders) == 3 and cached_tag

            def observe(_connection, _cursor, statement, _parameters, _context, _many):
                if "knowledge_bases" in statement and "FOR UPDATE" in statement:
                    waiting.set()
            event.listen(db.connection(), "before_cursor_execute", observe)
            try:
                result = library.update_documents(db, db.get(User, ids["actor"]), ids["kb"], ids["documents"], data)
                db.commit()
                return result
            except AppError as error:
                db.rollback()
                return error.code

    with pg_factory() as writer:
        actor = writer.get(User, ids["actor"])
        library.lock_kb_namespace(writer, actor, ids["kb"])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(batch)
            assert waiting.wait(5), "batch must reach and wait for the namespace lock"
            if change == "move_and_tags":
                library.update_document(writer, actor, ids["documents"][0], {"folder_id": ids["outside"],
                    "tag_ids": [ids["tag_b"]], "tag_mode": "add"})
                library.update_document(writer, actor, ids["documents"][1], {"deleted_at": True})
            elif change in {"delete_folder", "restore_parent"}:
                writer.get(Folder, ids["outside"] if change == "delete_folder" else ids["child"]).deleted_at = utcnow()
            elif change == "delete_tag":
                writer.delete(writer.get(Tag, ids["tag_c"]))
            elif change == "delete_document":
                writer.execute(delete(DocumentTag).where(DocumentTag.document_id == ids["documents"][0]))
                writer.delete(writer.get(Document, ids["documents"][0]))
            writer.commit()
            result = pending.result(timeout=10)
    if change != "move_and_tags":
        assert result == {"delete_folder": "invalid_folder", "delete_tag": "invalid_tags",
            "delete_document": "not_found", "restore_parent": "invalid_folder"}[change]
        with pg_factory() as db:
            assert all(doc.version == 1 for doc in db.scalars(select(Document).where(Document.id.in_(ids["documents"]))))
            assert db.scalar(select(AuditLog.id).where(AuditLog.kb_id == ids["kb"], AuditLog.action == "update_document")) is None
    else:
        assert [doc["id"] for doc in result] == ids["documents"]
        assert result[0]["folder_id"] == ids["outside"] and result[0]["version"] == 3
        assert set(result[0]["tag_ids"]) == {ids["tag"], ids["tag_b"], ids["tag_c"]}
        assert result[1]["deleted_at"] is not None and result[1]["version"] == 3
        with pg_factory() as db:
            logs = list(db.scalars(select(AuditLog).where(AuditLog.kb_id == ids["kb"], AuditLog.action == "update_document")))
            added = [log for log in logs if ids["tag_c"] in log.after["tag_ids"]]
            assert len(added) == 3
            first = next(log for log in added if log.entity_id == ids["documents"][0])
            assert first.before["version"] == 2 and first.before["folder_id"] == ids["outside"]
            assert set(first.before["tag_ids"]) == {ids["tag"], ids["tag_b"]}
