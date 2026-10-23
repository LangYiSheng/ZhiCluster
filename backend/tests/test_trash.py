from pathlib import Path

import pytest
from sqlalchemy import select, text

from app.core.config import get_settings
from app.db.models import (
    AgentEvent,
    AgentPlan,
    AgentPlanOperation,
    AgentRun,
    ChunkEmbedding,
    ClassificationSuggestion,
    Conversation,
    Document,
    DocumentChunk,
    DocumentSection,
    DocumentTag,
    EmbeddingProfile,
    IngestionJob,
    JobEvent,
    KnowledgeBase,
    KnowledgeBaseMember,
    Message,
    MessageCitation,
    StorageDeletion,
    Tag,
    UndoRecord,
    User,
    utcnow,
)
from app.services.permissions import DEMO_USER_ID
from app.services.storage_cleanup import cleanup_storage


@pytest.fixture(autouse=True)
def enforce_foreign_keys(factory):
    with factory() as db:
        db.execute(text("PRAGMA foreign_keys=ON"))


def upload(client, base, name="evidence.md"):
    result = client.post(f"/api/knowledge-bases/{base}/uploads", files=[("files", (name, f"# {name}\n真实测试内容。".encode()))])
    assert result.status_code == 200, result.text
    return result.json()["items"][0]["document"]["id"]


def test_list_owned_trash_search_and_paging(client, factory):
    for n in range(4):
        kb = client.post("/api/knowledge-bases", json={"name": f"删除库{n}"}).json()["id"]
        assert client.delete(f"/api/knowledge-bases/{kb}").status_code == 200
    with factory() as db:
        user = User(email="private@example.test", display_name="Other")
        db.add(user)
        db.flush()
        private = KnowledgeBase(owner_id=user.id, name="不可见", deleted_at=utcnow())
        db.add(private)
        db.flush()
        db.add(KnowledgeBaseMember(kb_id=private.id, user_id=user.id, role="owner"))
        db.commit()
        private_id = private.id
    result = client.get("/api/trash?kind=knowledge_base&page_size=2").json()
    assert result["total"] == result["counts"]["knowledge_base"] == 4
    assert len(result["items"]) == 2
    assert client.get("/api/trash?kind=knowledge_base&q=删除库2").json()["total"] == 1
    assert client.post("/api/trash/purge", json={"kind": "knowledge_base", "ids": [private_id], "confirm": True}).status_code == 404


def test_confirmation_and_active_resource_guard(client):
    kb = client.get("/api/knowledge-bases").json()[0]["id"]
    doc = upload(client, kb)
    assert client.post("/api/trash/purge", json={"kind": "all"}).status_code == 422
    assert client.post("/api/trash/purge", json={"kind": "all", "confirm": False}).status_code == 422
    assert client.post("/api/trash/purge", json={"kind": "document", "ids": [doc], "confirm": True}).status_code == 404
    assert client.get(f"/api/documents/{doc}").status_code == 200


def test_purge_document_dependencies_and_exact_file(client, factory):
    kb = client.get("/api/knowledge-bases").json()[0]["id"]
    doc_id = upload(client, kb)
    sibling = upload(client, kb, "keep.md")
    with factory() as db:
        doc = db.get(Document, doc_id)
        source = get_settings().upload_root / doc.storage_key
        section = DocumentSection(document_id=doc_id, kb_id=kb, plain_text="text")
        profile = EmbeddingProfile(fingerprint="fixture", model_name="fixture", dimension=2)
        tag = Tag(kb_id=kb, name="tag", normalized_name="tag")
        conversation = Conversation(user_id=DEMO_USER_ID)
        db.add_all([section, profile, tag, conversation])
        db.flush()
        chunk = DocumentChunk(document_id=doc_id, kb_id=kb, section_id=section.id, chunk_index=0, content="text", token_count=1)
        message = Message(conversation_id=conversation.id, role="assistant")
        db.add_all([chunk, message])
        db.flush()
        job = db.scalar(select(IngestionJob).where(IngestionJob.document_id == doc_id))
        db.add_all([
            ChunkEmbedding(kb_id=kb, chunk_id=chunk.id, profile_id=profile.id, embedding=[1, 0]),
            MessageCitation(message_id=message.id, chunk_id=chunk.id, document_id=doc_id, ordinal=1, snippet="text"),
            DocumentTag(document_id=doc_id, kb_id=kb, tag_id=tag.id),
            ClassificationSuggestion(kb_id=kb, document_id=doc_id, document_version=1),
            JobEvent(job_id=job.id, sequence=1, type="queued"),
        ])
        db.commit()
    assert client.delete(f"/api/documents/{doc_id}").status_code == 200
    result = client.post("/api/trash/purge", json={"kind": "document", "ids": [doc_id], "confirm": True})
    assert result.status_code == 200, result.text
    assert result.json()["deleted"]["document"] == 1
    assert not source.exists()
    assert client.get(f"/api/documents/{sibling}").status_code == 200
    with factory() as db:
        assert db.get(Message, message.id) is not None
        assert db.scalar(select(MessageCitation)) is None


def test_folder_subtree_and_deleted_kb_are_separate(client, factory):
    kb = client.get("/api/knowledge-bases").json()[0]["id"]
    root = client.post(f"/api/knowledge-bases/{kb}/folders", json={"name": "Parent"}).json()["id"]
    child = client.post(f"/api/knowledge-bases/{kb}/folders", json={"name": "Child", "parent_id": root}).json()["id"]
    doc = upload(client, kb)
    assert client.patch(f"/api/documents/{doc}", json={"folder_id": child}).status_code == 200
    assert client.delete(f"/api/folders/{root}").status_code == 200
    result = client.post("/api/trash/purge", json={"kind": "folder", "ids": [root], "confirm": True})
    assert result.status_code == 200, result.text
    assert result.json()["deleted"] == {"document": 1, "folder": 2, "knowledge_base": 0}
    doc = upload(client, kb)
    assert client.delete(f"/api/knowledge-bases/{kb}").status_code == 200
    assert client.get("/api/trash?kind=document").json()["total"] == 0
    assert client.get("/api/trash?kind=knowledge_base").json()["items"][0]["document_count"] == 1


def test_purge_kb_agent_dependencies_and_running_guard(client, factory):
    kb = client.get("/api/knowledge-bases").json()[0]["id"]
    doc = upload(client, kb)
    with factory() as db:
        job = db.scalar(select(IngestionJob).where(IngestionJob.document_id == doc))
        job.status = "running"
        run = AgentRun(kb_id=kb, actor_id=DEMO_USER_ID, thread_id="trash-test-thread", goal="test", status="completed")
        db.add(run)
        db.flush()
        plan = AgentPlan(run_id=run.id, kb_id=kb, payload={})
        db.add(plan)
        db.flush()
        db.add_all([AgentPlanOperation(plan_id=plan.id, operation_id="op", payload={}),
                    AgentEvent(run_id=run.id, sequence=1, type="done"),
                    UndoRecord(run_id=run.id, entity_type="document", entity_id=doc, before={}, after_version=1)])
        db.commit()
        job_id = job.id
    assert client.delete(f"/api/knowledge-bases/{kb}").status_code == 200
    body = {"kind": "all", "confirm": True}
    assert client.post("/api/trash/purge", json=body).status_code == 409
    with factory() as db:
        assert db.get(Document, doc)
        db.get(IngestionJob, job_id).status = "cancelled"
        db.commit()
    result = client.post("/api/trash/purge", json=body)
    assert result.status_code == 200, result.text
    with factory() as db:
        assert db.get(KnowledgeBase, kb) is None
        assert db.scalar(select(AgentRun)) is None


def test_cleanup_failure_owner_and_path_boundaries(factory, tmp_path, monkeypatch):
    root = tmp_path / "uploads"
    source = root / "kb/doc/original"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"data")
    outside = tmp_path / "keep.txt"
    outside.write_bytes(b"keep")
    with factory() as db:
        db.add_all([StorageDeletion(owner_id="owner", storage_key="kb/doc/original"),
                    StorageDeletion(owner_id="owner", storage_key="../keep.txt"),
                    StorageDeletion(owner_id="other", storage_key="elsewhere/doc/original")])
        db.commit()
        original = Path.unlink
        def unavailable(path, **kwargs):
            if path == source:
                raise PermissionError("locked")
            return original(path, **kwargs)
        monkeypatch.setattr(Path, "unlink", unavailable)
        assert cleanup_storage(db, root, "owner") == 0
        assert all(row.attempts == 1 for row in db.scalars(select(StorageDeletion).where(StorageDeletion.owner_id == "owner")))
        monkeypatch.setattr(Path, "unlink", original)
        assert cleanup_storage(db, root, "owner") == 1
        assert outside.read_bytes() == b"keep"
        assert db.scalar(select(StorageDeletion).where(StorageDeletion.owner_id == "other")).attempts == 0


def test_cleanup_unlinks_leaf_link_without_deleting_target(factory, tmp_path):
    root = tmp_path / "uploads"
    target = root / "keep/doc/original"
    link = root / "deleted/doc/original"
    target.parent.mkdir(parents=True)
    link.parent.mkdir(parents=True)
    target.write_bytes(b"other document")
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("Symlink creation unavailable on this Windows account")
    with factory() as db:
        db.add(StorageDeletion(owner_id="owner", storage_key="deleted/doc/original"))
        db.commit()
        assert cleanup_storage(db, root, "owner") == 1
    assert target.read_bytes() == b"other document"
    assert not link.is_symlink()
