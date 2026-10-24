"""Bounded SQL and transactional semantics for metadata batch operations."""

import pytest
from sqlalchemy import event, select, text

from app.db.models import (
    AuditLog,
    Document,
    DocumentTag,
    Folder,
    KnowledgeBase,
    KnowledgeBaseMember,
    Tag,
    utcnow,
)
from app.services.permissions import DEMO_USER_ID


def seed_batch(factory, count=200):
    with factory() as db:
        db.execute(text("PRAGMA foreign_keys=ON"))
        kb = db.scalar(select(KnowledgeBase))
        source, target = [Folder(kb_id=kb.id, name=name) for name in ("原目录", "目标目录")]
        a, b = [Tag(kb_id=kb.id, name=name, normalized_name=name) for name in ("原标签", "新标签")]
        db.add_all([source, target, a, b])
        db.flush()
        docs = [Document(kb_id=kb.id, owner_id=DEMO_USER_ID, folder_id=source.id, display_name=f"batch-{n:03d}.txt",
            original_filename=f"batch-{n:03d}.txt", mime_type="text/plain", ext="txt", sha256=str(n), size_bytes=1,
            storage_key=f"batch-tests/{n}/original") for n in range(count)]
        db.add_all(docs)
        db.flush()
        db.add_all(DocumentTag(document_id=doc.id, tag_id=a.id, kb_id=kb.id) for doc in docs)
        db.commit()
        return {"kb": kb.id, "documents": [doc.id for doc in docs], "source": source.id, "target": target.id,
            "tag_a": a.id, "tag_b": b.id}


@pytest.mark.parametrize("action, mode", [
    ("move", None), ("tags", "set"), ("tags", "add"), ("tags", "remove"), ("trash", None), ("restore", None),
])
def test_200_document_batch_bounds_sql_and_preserves_versions_order_and_audit(client, factory, action, mode):
    ids = seed_batch(factory)
    if action == "restore":
        with factory() as db:
            for doc in db.scalars(select(Document)):
                doc.deleted_at = utcnow()
            db.commit()
    statements = []

    def observe(_conn, _cursor, sql, _parameters, _context, _many):
        if sql.lstrip().startswith("SELECT"):
            statements.append(sql)

    body = {"kb_id": ids["kb"], "document_ids": list(reversed(ids["documents"])), "action": action,
        "folder_id": ids["target"], "tag_ids": [ids["tag_a"] if mode == "remove" else ids["tag_b"]]}
    if mode:
        body["tag_mode"] = mode
    engine = factory.kw["bind"]
    event.listen(engine, "before_cursor_execute", observe)
    try:
        result = client.post("/api/documents/batch", json=body)
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert result.status_code == 200, result.text
    items = result.json()["items"]
    assert [doc["id"] for doc in items] == body["document_ids"]
    assert all(doc["version"] == 2 for doc in items)
    assert len(statements) <= 15
    expected_tags = ({ids["tag_b"]} if mode == "set" else {ids["tag_a"], ids["tag_b"]}
        if mode == "add" else set() if mode == "remove" else {ids["tag_a"]})
    assert all(set(doc["tag_ids"]) == expected_tags for doc in items)
    assert all(doc["folder_id"] == (ids["target"] if action == "move" else ids["source"]) for doc in items)
    if action in {"trash", "restore"}:
        assert all(bool(doc["deleted_at"]) == (action == "trash") for doc in items)
    with factory() as db:
        logs = list(db.scalars(select(AuditLog).where(AuditLog.action == "update_document")))
        assert len(logs) == 200
        for log in logs:
            assert log.before["version"] == 1 and log.after["version"] == 2
            assert log.before["tag_ids"] == [ids["tag_a"]]
            assert set(log.after["tag_ids"]) == expected_tags


@pytest.mark.parametrize("kind", ["missing", "cross_kb", "invalid_tag", "invalid_folder", "restore_deleted_parent"])
def test_invalid_batch_preserves_every_document_and_audit(client, factory, kind):
    ids = seed_batch(factory, count=2)
    with factory() as db:
        if kind == "cross_kb":
            other = KnowledgeBase(owner_id=DEMO_USER_ID, name="另库")
            db.add(other)
            db.flush()
            db.add(KnowledgeBaseMember(kb_id=other.id, user_id=DEMO_USER_ID, role="owner"))
            foreign = Document(kb_id=other.id, owner_id=DEMO_USER_ID, display_name="foreign.txt", original_filename="foreign.txt",
                mime_type="text/plain", ext="txt", sha256="f", size_bytes=1, storage_key="batch-tests/foreign/original")
            db.add(foreign)
            db.flush()
            selected = [ids["documents"][0], foreign.id]
        else:
            selected = ids["documents"] + (["missing-document"] if kind == "missing" else [])
        if kind == "restore_deleted_parent":
            db.get(Folder, ids["target"]).deleted_at = utcnow()
            db.get(Document, ids["documents"][1]).folder_id = ids["target"]
            for doc in db.scalars(select(Document)):
                doc.deleted_at = utcnow()
        db.commit()
        before = {doc.id: (doc.version, doc.folder_id, bool(doc.deleted_at)) for doc in db.scalars(select(Document))}
    body = {"kb_id": ids["kb"], "document_ids": selected, "action": "trash"}
    if kind == "invalid_tag":
        body.update({"action": "tags", "tag_ids": ["missing-tag"]})
    elif kind == "invalid_folder":
        body.update({"action": "move", "folder_id": ""})
    elif kind == "restore_deleted_parent":
        body["action"] = "restore"
    result = client.post("/api/documents/batch", json=body)
    assert result.status_code == (404 if kind == "missing" else 400), result.text
    with factory() as db:
        assert {doc.id: (doc.version, doc.folder_id, bool(doc.deleted_at)) for doc in db.scalars(select(Document))} == before
        assert db.scalar(select(AuditLog.id).where(AuditLog.action == "update_document")) is None
        assert len(list(db.scalars(select(DocumentTag)))) == 2


@pytest.mark.parametrize("action, mode", [("move", None), ("tags", "add"), ("tags", "set"), ("restore", None)])
def test_duplicate_ids_and_no_op_still_increment_version_once(client, factory, action, mode):
    ids = seed_batch(factory, count=2)
    selected = [ids["documents"][1], ids["documents"][0], ids["documents"][1]]
    body = {"kb_id": ids["kb"], "document_ids": selected, "action": action,
        "folder_id": ids["source"], "tag_ids": [ids["tag_a"]]}
    if mode:
        body["tag_mode"] = mode
    result = client.post("/api/documents/batch", json=body)
    assert result.status_code == 200, result.text
    assert [doc["id"] for doc in result.json()["items"]] == selected[:2]
    assert all(doc["version"] == 2 for doc in result.json()["items"])
    with factory() as db:
        assert len(list(db.scalars(select(AuditLog).where(AuditLog.action == "update_document")))) == 2
        assert len(list(db.scalars(select(DocumentTag)))) == 2
    assert client.patch(f"/api/documents/{selected[0]}", json={"display_name": "stale.txt", "version": 1}).status_code == 409


def test_tag_deltas_and_clearing_never_modify_unselected_documents(client, factory):
    ids = seed_batch(factory, count=3)
    first, second, untouched = ids["documents"]
    endpoint = "/api/documents/batch"
    assert client.post(endpoint, json={"kb_id": ids["kb"], "document_ids": [first, second], "action": "tags",
        "tag_ids": [ids["tag_b"]], "tag_mode": "add"}).status_code == 200
    # An explicit empty set clears only the selected document's memberships.
    cleared = client.post(endpoint, json={"kb_id": ids["kb"], "document_ids": [first], "action": "tags", "tag_ids": []})
    assert cleared.status_code == 200 and cleared.json()["items"][0]["tag_ids"] == []
    removed = client.post(endpoint, json={"kb_id": ids["kb"], "document_ids": [first, second], "action": "tags",
        "tag_ids": [ids["tag_a"]], "tag_mode": "remove"})
    assert removed.status_code == 200
    assert [set(item["tag_ids"]) for item in removed.json()["items"]] == [set(), {ids["tag_b"]}]
    with factory() as db:
        assert db.get(Document, untouched).version == 1
        assert set(db.scalars(select(DocumentTag.tag_id).where(DocumentTag.document_id == untouched))) == {ids["tag_a"]}
        assert {(item.document_id, item.tag_id) for item in db.scalars(select(DocumentTag))} == {
            (second, ids["tag_b"]), (untouched, ids["tag_a"])}


def test_root_move_is_valid_but_viewer_and_oversized_batch_cannot_write(client, factory):
    ids = seed_batch(factory, count=2)
    body = {"kb_id": ids["kb"], "document_ids": ids["documents"], "action": "move", "folder_id": None}
    result = client.post("/api/documents/batch", json=body)
    assert result.status_code == 200 and all(doc["folder_id"] is None for doc in result.json()["items"])
    assert client.post("/api/documents/batch", json={**body, "document_ids": [ids["documents"][0]] * 201}).status_code == 422
    with factory() as db:
        db.scalar(select(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == ids["kb"],
            KnowledgeBaseMember.user_id == DEMO_USER_ID)).role = "viewer"
        db.commit()
    result = client.post("/api/documents/batch", json={**body, "folder_id": ids["source"]})
    assert result.status_code == 403
    with factory() as db:
        assert all(doc.version == 2 and doc.folder_id is None for doc in db.scalars(select(Document)))
