"""Scale and malformed-input regressions for document/folder management."""

import pytest
from sqlalchemy import event, select

from app.db.models import AuditLog, Document, DocumentTag, Folder, KnowledgeBase, Tag, utcnow
from app.services.library import descendants
from app.services.permissions import DEMO_USER_ID


def seed_documents(factory, count):
    with factory() as db:
        base = db.scalar(select(KnowledgeBase))
        tag = Tag(kb_id=base.id, name="共享标签", normalized_name="共享标签")
        db.add(tag)
        db.flush()
        documents = [Document(kb_id=base.id, owner_id=DEMO_USER_ID, display_name=f"资料{n:03d}.txt",
            original_filename=f"资料{n:03d}.txt", mime_type="text/plain", ext="txt", sha256=str(n),
            size_bytes=1, storage_key=f"{base.id}/scale-{n}/original") for n in range(count)]
        db.add_all(documents)
        db.flush()
        db.add_all(DocumentTag(kb_id=base.id, document_id=doc.id, tag_id=tag.id)
            for index, doc in enumerate(documents) if index % 2 == 0)
        db.commit()
        return base.id, tag.id


def test_document_page_loads_all_tags_in_one_query(client, factory):
    base, tag = seed_documents(factory, 200)
    tag_queries = []

    def observe(_connection, _cursor, statement, _parameters, _context, _many):
        if "SELECT" in statement and "FROM document_tags" in statement:
            tag_queries.append(statement)

    engine = factory.kw["bind"]
    event.listen(engine, "before_cursor_execute", observe)
    try:
        result = client.get(f"/api/knowledge-bases/{base}/documents?sort=name&page_size=200")
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["total"] == 200 and len(data["items"]) == 200
    assert [doc["tag_ids"] for doc in data["items"]] == [[tag] if index % 2 == 0 else [] for index in range(200)]
    assert len(tag_queries) == 1


def test_descendants_deep_tree_excludes_deleted_and_foreign_branches(factory):
    with factory() as db:
        base = db.scalar(select(KnowledgeBase))
        other = KnowledgeBase(name="另一个库", owner_id=DEMO_USER_ID)
        db.add(other)
        db.flush()
        chain = [Folder(id=f"deep-{n:04d}", kb_id=base.id, name=str(n), parent_id=f"deep-{n - 1:04d}" if n else None)
            for n in range(1500)]
        db.add_all(chain)
        db.add_all([Folder(id="deleted-child", kb_id=base.id, name="已删除", parent_id="deep-0000", deleted_at=utcnow()),
            Folder(id="under-deleted", kb_id=base.id, name="不可达", parent_id="deleted-child"),
            Folder(id="foreign-root", kb_id=other.id, name="别库")])
        db.commit()
        assert descendants(db, base.id, ["deep-0000", "deep-1000"]) == {folder.id for folder in chain}
        assert descendants(db, base.id, []) == set()
        from app.core.errors import AppError
        for invalid in ["deleted-child", "foreign-root", "missing"]:
            with pytest.raises(AppError) as error:
                descendants(db, base.id, [invalid])
            assert error.value.code == "invalid_folder"


def test_folder_delete_batches_metadata_but_preserves_audit_and_restore_order(client, factory):
    base, tag = seed_documents(factory, 200)
    root = client.post(f"/api/knowledge-bases/{base}/folders", json={"name": "一批资料"}).json()["id"]
    child = client.post(f"/api/knowledge-bases/{base}/folders", json={"name": "子目录", "parent_id": root}).json()["id"]
    with factory() as db:
        docs = list(db.scalars(select(Document).where(Document.kb_id == base).order_by(Document.display_name)))
        for index, doc in enumerate(docs):
            doc.folder_id = child if index % 2 else root
        db.commit()
        ids = [doc.id for doc in docs]
    statements = []

    def observe(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    engine = factory.kw["bind"]
    event.listen(engine, "before_cursor_execute", observe)
    try:
        response = client.delete(f"/api/folders/{root}")
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert response.status_code == 200 and response.json()["folders"] == 2
    assert len(statements) < 20
    assert client.get(f"/api/knowledge-bases/{base}/documents").json()["total"] == 0
    with factory() as db:
        docs = list(db.scalars(select(Document).where(Document.id.in_(ids))))
        assert all(doc.deleted_at and doc.version == 2 for doc in docs)
        audits = list(db.scalars(select(AuditLog).where(AuditLog.action == "update_document")))
        assert len(audits) == 200
        for audit in audits:
            assert audit.before["deleted_at"] is None and audit.after["deleted_at"] is not None
            assert audit.before["version"] == 1 and audit.after["version"] == 2
            assert audit.before["tag_ids"] == audit.after["tag_ids"]
        assert db.scalar(select(DocumentTag.tag_id).limit(1)) == tag
    assert client.post(f"/api/folders/{child}/restore").status_code == 400
    assert client.post(f"/api/documents/{ids[0]}/restore").status_code == 400
    assert client.post(f"/api/folders/{root}/restore").status_code == 200
    assert client.post(f"/api/folders/{child}/restore").status_code == 200
    assert client.post(f"/api/documents/{ids[0]}/restore").status_code == 200


@pytest.mark.parametrize("entity, changes", [
    ("folder", {"name": None}), ("document", {"display_name": None}), ("document", {"tag_ids": None}),
    ("document", {"display_name": "不应保存.txt", "tag_ids": None}),
])
def test_null_metadata_returns_validation_error_without_mutation(client, factory, entity, changes):
    base, tag = seed_documents(factory, 1)
    if entity == "folder":
        created = client.post(f"/api/knowledge-bases/{base}/folders", json={"name": "原目录"}).json()
        path = f"/api/folders/{created['id']}"
    else:
        created = client.get(f"/api/knowledge-bases/{base}/documents").json()["items"][0]
        path = f"/api/documents/{created['id']}"
    response = client.patch(path, json=changes)
    assert response.status_code == 400, response.text
    if entity == "folder":
        current = client.get(f"/api/knowledge-bases/{base}/folders").json()[0]
        assert current["name"] == "原目录"
    else:
        current = client.get(path).json()
        assert current["display_name"] == created["display_name"] and current["tag_ids"] == [tag]
    assert current["version"] == created["version"]
