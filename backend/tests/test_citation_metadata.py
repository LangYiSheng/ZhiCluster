"""Citation cards use current authorized metadata, including historical replay."""

import json

import pytest
from sqlalchemy import delete, func, select
from test_chat_tools import settings, start_chat

from app.ai.gateway import ModelGateway
from app.db.models import (
    ConversationEvent,
    Document,
    DocumentChunk,
    EmbeddingProfile,
    Folder,
    IngestionJob,
    KnowledgeBase,
    KnowledgeBaseMember,
    Message,
    MessageCitation,
    utcnow,
)
from app.retrieval.chat_tools import current_hits
from app.retrieval.search import search_knowledge
from app.services.chat import process_chat_job
from app.services.citations import visible_citation
from app.services.permissions import get_actor


@pytest.fixture
def old_citation(client, factory):
    kb_id, doc_id, chunk_id, conversation_id, message_id, job_id = start_chat(client, factory, retrieval_mode="direct")
    with factory() as db:
        db.get(Message, message_id).status = "completed"
        db.get(IngestionJob, job_id).status = "completed"
        db.get(Document, doc_id).short_summary = "SUMMARY_IS_NOT_CITATION"
        db.add(MessageCitation(message_id=message_id, document_id=doc_id, chunk_id=chunk_id,
            ordinal=1, snippet="名额为28人。", anchors={"paragraph_start": 1}))
        sequence = db.scalar(select(func.max(ConversationEvent.sequence)).where(ConversationEvent.conversation_id == conversation_id)) or 0
        db.add(ConversationEvent(conversation_id=conversation_id, sequence=sequence + 1, type="citation", data={
            "message_id": message_id, "document_id": doc_id, "chunk_id": chunk_id, "ordinal": 1,
            "snippet": "名额为28人。", "anchors": {"paragraph_start": 1},
            "document_name": "OLD_PRIVATE_NAME", "kb_id": "OLD_PRIVATE_KB", "kb_name": "OLD_PRIVATE_KB_NAME",
            "ext": "OLD_PRIVATE_EXT", "display_name": "OLD_PRIVATE_ALIAS", "content": "FORGED_FULL_TEXT"}))
        db.commit()
    return kb_id, doc_id, chunk_id, conversation_id, message_id


def replay_citations(client, conversation_id):
    response = client.get(f"/api/conversations/{conversation_id}/events")
    assert response.status_code == 200
    return [json.loads(block.split("data: ", 1)[1]) for block in response.text.split("\n\n") if "event: citation\n" in block]


def test_legacy_snapshot_and_sse_enrich_current_document_and_kb_without_summary_or_payload_metadata(client, factory, old_citation):
    kb_id, doc_id, _, conversation_id, _ = old_citation
    with factory() as db:
        db.get(Document, doc_id).display_name = "当前名称.pptx"
        db.get(Document, doc_id).ext = "pptx"
        db.get(KnowledgeBase, kb_id).name = "当前知识库"
        db.commit()
    snapshot = client.get(f"/api/conversations/{conversation_id}/messages").json()[-1]["citations"][0]
    replay = replay_citations(client, conversation_id)[0]
    for citation in (snapshot, replay):
        assert citation["available"] is True
        assert {key: citation[key] for key in ("document_name", "ext", "kb_id", "kb_name", "snippet")} == {
            "document_name": "当前名称.pptx", "ext": "pptx", "kb_id": kb_id, "kb_name": "当前知识库", "snippet": "名额为28人。"}
        assert "OLD_PRIVATE" not in str(citation)
        assert "FORGED_FULL_TEXT" not in str(citation) and "SUMMARY_IS_NOT_CITATION" not in str(citation)


@pytest.mark.parametrize("change", ["document", "folder", "missing_chunk"])
def test_unavailable_citation_masks_all_card_metadata_in_snapshot_and_replay(client, factory, old_citation, change):
    kb_id, doc_id, chunk_id, conversation_id, _ = old_citation
    with factory() as db:
        if change == "document":
            db.get(Document, doc_id).deleted_at = utcnow()
        elif change == "folder":
            folder = Folder(kb_id=kb_id, name="删除目录", deleted_at=utcnow())
            db.add(folder)
            db.flush()
            db.get(Document, doc_id).folder_id = folder.id
        else:
            db.execute(delete(DocumentChunk).where(DocumentChunk.id == chunk_id))
        db.commit()
    snapshot = client.get(f"/api/conversations/{conversation_id}/messages").json()[-1]["citations"][0]
    replay = replay_citations(client, conversation_id)[0]
    for citation in (snapshot, replay):
        assert citation["available"] is False and citation["document_name"] == "来源不可用"
        assert citation["snippet"] == "来源已删除或不可访问" and citation["anchors"] == {}
        assert all(citation[field] is None for field in ("ext", "kb_id", "kb_name"))
        assert "名额为28人" not in str(citation) and "OLD_PRIVATE" not in str(citation)
        assert "FORGED_FULL_TEXT" not in str(citation)


@pytest.mark.parametrize("change", ["membership", "knowledge_base"])
def test_removed_scope_permission_blocks_history_and_replay_without_metadata(client, factory, old_citation, change):
    kb_id, _, _, conversation_id, _ = old_citation
    with factory() as db:
        if change == "membership":
            db.execute(delete(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == kb_id))
        else:
            db.get(KnowledgeBase, kb_id).deleted_at = utcnow()
        db.commit()
    for path in ("messages", "events"):
        response = client.get(f"/api/conversations/{conversation_id}/{path}")
        assert response.status_code in {403, 404}
        assert "名额为28人" not in response.text and "OLD_PRIVATE" not in response.text


def test_projection_refreshes_authorization_and_does_not_unmask_outside_conversation_scope(client, factory, old_citation):
    kb_id, doc_id, chunk_id, _, _ = old_citation
    with factory() as db:
        actor = get_actor(db)
        data = {"document_id": doc_id, "chunk_id": chunk_id, "snippet": "PRIVATE_SNIPPET", "kb_name": "SPOOFED"}
        assert visible_citation(db, actor, data, kb_ids=[kb_id])["available"]
        assert not visible_citation(db, actor, data, kb_ids=["different-selected-kb"])["available"]
        with factory() as writer:
            writer.execute(delete(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == kb_id))
            writer.commit()
        masked = visible_citation(db, actor, data, kb_ids=[kb_id])
        assert masked["available"] is False and "PRIVATE_SNIPPET" not in str(masked)
        assert masked["kb_name"] is None


def test_live_candidate_and_final_citation_events_have_authorized_metadata(client, factory, monkeypatch):
    kb_id, doc_id, _, conversation_id, _, job_id = start_chat(client, factory, retrieval_mode="direct")
    monkeypatch.setattr(ModelGateway, "stream_chat", lambda *_args, **_kwargs: iter(["答案[S1]"]))
    process_chat_job(job_id, factory, settings(), owner="current")
    with factory() as db:
        doc, kb = db.get(Document, doc_id), db.get(KnowledgeBase, kb_id)
        events = list(db.scalars(select(ConversationEvent).where(ConversationEvent.conversation_id == conversation_id,
            ConversationEvent.type == "citation").order_by(ConversationEvent.sequence)))
        assert len(events) == 2 and events[0].data["candidate"] is True
        for event in events:
            assert event.data["ext"] == doc.ext and event.data["kb_name"] == kb.name and event.data["kb_id"] == kb_id
            assert event.data["document_name"] == doc.display_name and event.data["available"] is True
            assert "content" not in event.data


def test_search_and_current_hits_refresh_metadata_after_provider_wait(client, factory, monkeypatch):
    kb_id, doc_id, _, _, _, _ = start_chat(client, factory, retrieval_mode="direct")
    class Gateway:
        embeddings_configured, profile_fingerprint = True, "citation-profile"
        def __init__(self, _settings):
            pass
        def embed(self, _texts):
            with factory() as writer:
                writer.get(Document, doc_id).display_name = "网络等待后改名.pptx"
                writer.get(Document, doc_id).ext = "pptx"
                writer.get(KnowledgeBase, kb_id).name = "网络等待后库名"
                writer.commit()
            return [[1.0, 0.0]]
    monkeypatch.setattr("app.retrieval.search.ModelGateway", Gateway)
    with factory() as db:
        db.add(EmbeddingProfile(fingerprint="citation-profile", model_name="fake", dimension=2))
        db.commit()
        scope = {"kb_ids": [kb_id]}
        result = search_knowledge(db, get_actor(db), {**scope, "query": "名额"}, settings())
        assert result["items"][0]["ext"] == "pptx" and result["items"][0]["kb_name"] == "网络等待后库名"
        with factory() as writer:
            writer.get(Document, doc_id).ext = "docx"
            writer.get(KnowledgeBase, kb_id).name = "再次改名"
            writer.commit()
        fresh = current_hits(db, get_actor(db), scope, result["items"])[0]
        assert fresh["ext"] == "docx" and fresh["kb_name"] == "再次改名"
    response = client.post("/api/search", json={"kb_ids": [kb_id], "query": "名额", "mode": "keyword"})
    assert response.status_code == 200
    assert response.json()["items"][0]["ext"] == "docx" and response.json()["items"][0]["kb_name"] == "再次改名"
