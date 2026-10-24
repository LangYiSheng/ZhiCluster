"""A resource removed while metadata writes await the KB lock must become 404."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import event, select
from test_ingestion_postgres import pg_factory as pg_factory

from app.api import library as api
from app.core.errors import AppError
from app.db.models import Document, Folder, KnowledgeBase, KnowledgeBaseMember, Tag, User, new_id, utcnow
from app.schemas.requests import KBUpdate, TagUpdate
from app.services import library
from app.services.trash import purge_trash

pytestmark = pytest.mark.skipif(not os.getenv("PG_INGESTION_TEST_URL"), reason="Set isolated PG_INGESTION_TEST_URL")


def create_resources(factory, restoring_folder=False, restoring_kb=False):
    with factory() as db:
        actor = User(email=f"disappearing-{new_id()}@example.test", display_name="资源生命周期专项")
        db.add(actor)
        db.flush()
        kb = KnowledgeBase(owner_id=actor.id, name="消失资源隔离测试", deleted_at=utcnow() if restoring_kb else None)
        db.add(kb)
        db.flush()
        db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
        folder = Folder(kb_id=kb.id, name="待清理目录", deleted_at=utcnow() if restoring_folder else None)
        tag = Tag(kb_id=kb.id, name="待删除标签", normalized_name="待删除标签")
        doc = Document(kb_id=kb.id, owner_id=actor.id, display_name="待清理.txt", original_filename="待清理.txt",
            mime_type="text/plain", ext="txt", sha256="0", size_bytes=1,
            storage_key=f"disappearing/{new_id()}/original")
        db.add_all([folder, tag, doc])
        db.commit()
        return {"actor": actor.id, "kb": kb.id, "folder": folder.id, "tag": tag.id, "document": doc.id}


@pytest.mark.parametrize("operation", ["document_update", "folder_update", "folder_restore", "folder_delete",
    "tag_update", "tag_delete", "kb_update", "kb_delete", "kb_restore"])
def test_metadata_write_reports_not_found_after_waiting_for_resource_deletion(pg_factory, monkeypatch, operation):
    ids = create_resources(pg_factory, restoring_folder=operation == "folder_restore", restoring_kb=operation == "kb_restore")
    monkeypatch.setattr(api, "get_actor", lambda db: db.get(User, ids["actor"]))
    waiting = threading.Event()

    def stale_request():
        with pg_factory() as db:
            def observe(_connection, _cursor, statement, _parameters, _context, _many):
                if "knowledge_bases" in statement and "FOR UPDATE" in statement:
                    waiting.set()
            event.listen(db.connection(), "before_cursor_execute", observe)
            try:
                if operation == "document_update":
                    library.update_document(db, db.get(User, ids["actor"]), ids["document"], {"display_name": "迟到改名.txt"})
                elif operation == "folder_update":
                    library.update_folder(db, db.get(User, ids["actor"]), ids["folder"], {"name": "迟到目录改名"})
                elif operation == "folder_restore":
                    api.restore_folder(ids["folder"], db=db)
                elif operation == "folder_delete":
                    api.delete_folder(ids["folder"], db=db)
                elif operation == "tag_update":
                    api.patch_tag(ids["tag"], TagUpdate(name="迟到标签改名"), db=db)
                elif operation == "tag_delete":
                    api.delete_tag(ids["tag"], db=db)
                elif operation == "kb_update":
                    api.patch_kb(ids["kb"], KBUpdate(name="迟到知识库改名"), db=db)
                elif operation == "kb_delete":
                    api.delete_kb(ids["kb"], db=db)
                else:
                    api.restore_kb(ids["kb"], db=db)
                db.commit()
                return "unexpected_success", 200
            except AppError as error:
                db.rollback()
                return error.code, error.status
            except Exception as error:
                db.rollback()
                return type(error).__name__, str(error)

    with pg_factory() as writer:
        if operation == "kb_restore":
            writer.scalar(select(KnowledgeBase).where(KnowledgeBase.id == ids["kb"]).with_for_update())
        else:
            library.lock_kb_namespace(writer, writer.get(User, ids["actor"]), ids["kb"])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(stale_request)
            assert waiting.wait(5), "the stale request must read the resource, then wait for the namespace lock"
            if operation.startswith("kb"):
                if operation != "kb_restore":
                    api.delete_kb(ids["kb"], db=writer)
                purge_trash(writer, ids["actor"], "knowledge_base", [ids["kb"]])
            elif operation.startswith("tag"):
                api.delete_tag(ids["tag"], db=writer)
                writer.commit()
            else:
                kind = "document" if operation == "document_update" else "folder"
                # Use the normal soft-delete then purge lifecycle while the
                # stale request has already observed the original resource.
                if kind == "document":
                    library.update_document(writer, writer.get(User, ids["actor"]), ids["document"], {"deleted_at": True})
                elif operation != "folder_restore":
                    api.delete_folder(ids["folder"], db=writer)
                purge_trash(writer, ids["actor"], kind, [ids[kind]])
            result = pending.result(timeout=10)
    assert result == ("not_found", 404), result


def rename_resource(db, ids, kind, name, version=1):
    if kind == "document":
        return library.update_document(db, db.get(User, ids["actor"]), ids[kind], {"display_name": name, "version": version})
    if kind == "folder":
        return library.update_folder(db, db.get(User, ids["actor"]), ids[kind], {"name": name, "version": version})
    if kind == "tag":
        return api.patch_tag(ids[kind], TagUpdate(name=name, version=version), db=db)
    return api.patch_kb(ids[kind], KBUpdate(name=name, version=version), db=db)


@pytest.mark.parametrize("kind", ["document", "folder", "tag", "kb"])
def test_lock_wait_still_preserves_optimistic_version_conflicts(pg_factory, monkeypatch, kind):
    ids = create_resources(pg_factory)
    monkeypatch.setattr(api, "get_actor", lambda db: db.get(User, ids["actor"]))
    waiting = threading.Event()

    def stale_request():
        with pg_factory() as db:
            def observe(_connection, _cursor, statement, _parameters, _context, _many):
                if "knowledge_bases" in statement and "FOR UPDATE" in statement:
                    waiting.set()
            event.listen(db.connection(), "before_cursor_execute", observe)
            try:
                rename_resource(db, ids, kind, "迟到请求不得覆盖", version=1)
                db.commit()
                return "unexpected_success", 200
            except AppError as error:
                db.rollback()
                return error.code, error.status

    with pg_factory() as writer:
        library.lock_kb_namespace(writer, writer.get(User, ids["actor"]), ids["kb"])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(stale_request)
            assert waiting.wait(5)
            rename_resource(writer, ids, kind, "已提交并发改名", version=1)
            writer.commit()
            assert pending.result(timeout=10) == ("version_conflict", 409)
    with pg_factory() as db:
        value = db.get({"document": Document, "folder": Folder, "tag": Tag, "kb": KnowledgeBase}[kind], ids[kind])
        assert value.version == 2
        assert getattr(value, "display_name" if kind == "document" else "name") == "已提交并发改名"


@pytest.mark.parametrize("change", ["soft_delete", "revoke_management"])
def test_kb_write_rechecks_visibility_and_management_after_wait(pg_factory, monkeypatch, change):
    ids = create_resources(pg_factory)
    monkeypatch.setattr(api, "get_actor", lambda db: db.get(User, ids["actor"]))
    waiting = threading.Event()

    def stale_request():
        with pg_factory() as db:
            def observe(_connection, _cursor, statement, _parameters, _context, _many):
                if "knowledge_bases" in statement and "FOR UPDATE" in statement:
                    waiting.set()
            event.listen(db.connection(), "before_cursor_execute", observe)
            try:
                api.patch_kb(ids["kb"], KBUpdate(name="迟到修改"), db=db)
                db.commit()
                return "unexpected_success", 200
            except AppError as error:
                db.rollback()
                return error.code, error.status

    with pg_factory() as writer:
        library.lock_kb_namespace(writer, writer.get(User, ids["actor"]), ids["kb"])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(stale_request)
            assert waiting.wait(5)
            if change == "soft_delete":
                api.delete_kb(ids["kb"], db=writer)
            else:
                member = writer.scalar(select(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == ids["kb"],
                    KnowledgeBaseMember.user_id == ids["actor"]))
                member.role = "viewer"
            writer.commit()
            assert pending.result(timeout=10) == (("not_found", 404) if change == "soft_delete" else ("forbidden", 403))
    with pg_factory() as db:
        assert db.get(KnowledgeBase, ids["kb"]).name == "消失资源隔离测试"


def test_cached_kb_cannot_mask_namespace_disappearance_after_whole_kb_purge(pg_factory, monkeypatch):
    ids = create_resources(pg_factory)
    monkeypatch.setattr(api, "get_actor", lambda db: db.get(User, ids["actor"]))
    waiting = threading.Event()

    def stale_child_update():
        with pg_factory() as db:
            cached = db.get(KnowledgeBase, ids["kb"])
            assert cached is not None and cached.deleted_at is None

            def observe(_connection, _cursor, statement, _parameters, _context, _many):
                if "knowledge_bases" in statement and "FOR UPDATE" in statement:
                    waiting.set()
            event.listen(db.connection(), "before_cursor_execute", observe)
            try:
                library.update_document(db, db.get(User, ids["actor"]), ids["document"], {"display_name": "迟到文档修改"})
                db.commit()
                return "unexpected_success", 200
            except AppError as error:
                db.rollback()
                return error.code, error.status

    with pg_factory() as writer:
        library.lock_kb_namespace(writer, writer.get(User, ids["actor"]), ids["kb"])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(stale_child_update)
            assert waiting.wait(5), "the cached-KB request must wait for the namespace lock"
            api.delete_kb(ids["kb"], db=writer)
            purge_trash(writer, ids["actor"], "knowledge_base", [ids["kb"]])
            assert pending.result(timeout=10) == ("not_found", 404)
