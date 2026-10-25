"""Real database/API, per-profile embedding and interleaved public tool streams."""

import json

import httpx
import pytest
from sqlalchemy import delete, select

from app.ai.gateway import ModelGateway
from app.core.config import Settings, get_settings
from app.db.models import (
    ChunkEmbedding,
    ConversationEvent,
    Document,
    DocumentChunk,
    DocumentSection,
    EmbeddingProfile,
    Folder,
    IngestionJob,
    Message,
    new_id,
)
from app.retrieval.search import search_knowledge
from app.services.chat import process_chat_job
from app.services.permissions import get_actor
from app.worker.pipeline import process_ingestion_job


def source(db, kb_id, text="真实文档内容", *, name="参考.txt", size=12):
    doc = Document(kb_id=kb_id, owner_id=get_actor(db).id, display_name=name, original_filename=name,
        storage_key=new_id(), sha256=new_id(), mime_type="text/plain", ext="txt", size_bytes=size,
        parse_status="ready", index_status="ready")
    db.add(doc)
    db.flush()
    section = DocumentSection(kb_id=kb_id, document_id=doc.id, plain_text=text)
    db.add(section)
    db.flush()
    chunk = DocumentChunk(kb_id=kb_id, document_id=doc.id, section_id=section.id, chunk_index=0,
        content=text, token_count=len(text))
    db.add(chunk)
    db.flush()
    return doc, chunk


def test_kb_appearance_and_embedding_override_roundtrip(client):
    created = client.post("/api/knowledge-bases", json={"name": "课程", "icon": "book-open",
        "color": "#aabbcc", "embedding_model": "embed-course", "embedding_dimension": 3})
    assert created.status_code == 201, created.text
    kb = created.json()
    assert (kb["icon"], kb["color"], kb["embedding_model"], kb["embedding_dimension"]) == ("book-open", "#aabbcc", "embed-course", 3)
    changed = client.patch(f"/api/knowledge-bases/{kb['id']}", json={"embedding_model": None,
        "embedding_dimension": None, "version": kb["version"]})
    assert changed.status_code == 200 and changed.json()["embedding_model"] is None
    assert client.post("/api/knowledge-bases", json={"name": "坏颜色", "color": "red"}).status_code == 422


def test_history_ownership_ignores_cross_library_reference_and_statistics(client, factory):
    first = client.get("/api/knowledge-bases").json()[0]["id"]
    second = client.post("/api/knowledge-bases", json={"name": "第二个"}).json()["id"]
    chat = client.post("/api/conversations", json={"kb_id": first, "scope": {"kb_ids": [second]}}).json()
    assert chat["kb_id"] == first and chat["scope"]["kb_ids"] == [second]
    assert [item["id"] for item in client.get(f"/api/conversations?kb_id={first}").json()] == [chat["id"]]
    assert client.get(f"/api/conversations?kb_id={second}").json() == []
    with factory() as db:
        source(db, first, size=123)
        source(db, second, size=456)
        db.add(Message(conversation_id=chat["id"], role="user", content="问题"))
        db.commit()
    stats = client.get(f"/api/settings/statistics?kb_id={first}").json()
    assert stats == {"knowledge_bases": 1, "documents": 1, "folders": 0, "tags": 0,
        "conversations": 1, "messages": 1, "storage_bytes": 123, "chunks": 1, "indexed_documents": 0, "failed_jobs": 0}
    assert client.get(f"/api/settings/statistics?kb_id={second}").json()["conversations"] == 0


def test_saved_model_list_roundtrip_and_default_is_selectable(client, monkeypatch, tmp_path):
    import app.api.workflows as api

    base = Settings(_env_file=None, runtime_config_dir=tmp_path / "runtime")
    monkeypatch.setattr(api, "get_settings", lambda: base)
    response = client.put("/api/settings/config", json={"revision": 0,
        "llm": {"model": "default", "models": ["selected", "selected"]}})
    assert response.status_code == 200, response.text
    assert response.json()["llm"]["models"] == ["default", "selected"]
    assert client.get("/api/settings/config").json()["llm"]["models"] == ["default", "selected"]
    assert client.get("/api/settings/chat-models").json()["models"] == ["default", "selected"]


@pytest.mark.parametrize("paths", [["safe/a.txt", "../b.txt"], ["/a.txt", "b.txt"],
    ["C:/a.txt", "b.txt"], ["safe/a.txt"], ["safe/a.txt", "safe/a.txt"]])
def test_upload_path_batch_validation_has_no_partial_folders_or_documents(client, factory, paths):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    response = client.post(f"/api/knowledge-bases/{kb_id}/uploads", data={"relative_paths": json.dumps(paths)},
        files=[("files", ("a.txt", b"alpha", "text/plain")), ("files", ("b.txt", b"beta", "text/plain"))])
    assert response.status_code == 422, response.text
    with factory() as db:
        assert not list(db.scalars(select(Document))) and not list(db.scalars(select(Folder)))


def test_folder_upload_preserves_tree_and_browsing_search_sort(client, factory):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    result = client.post(f"/api/knowledge-bases/{kb_id}/uploads", data={"relative_paths": json.dumps(["课程/章节/a.txt", "课程/b.txt"])},
        files=[("files", ("a.txt", b"alpha", "text/plain")), ("files", ("b.txt", b"beta more", "text/plain"))])
    assert result.status_code == 200 and len(result.json()["jobs"]) == 2, result.text
    folders = client.get(f"/api/knowledge-bases/{kb_id}/folders").json()
    parent = next(folder for folder in folders if folder["name"] == "课程")
    child = next(folder for folder in folders if folder["name"] == "章节")
    assert child["parent_id"] == parent["id"]
    assert client.get(f"/api/knowledge-bases/{kb_id}/documents?folder_id=root&include_descendants=false").json()["total"] == 0
    direct = client.get(f"/api/knowledge-bases/{kb_id}/documents?folder_id={parent['id']}&include_descendants=false").json()
    assert [item["display_name"] for item in direct["items"]] == ["b.txt"]
    assert client.get(f"/api/knowledge-bases/{kb_id}/documents?folder_id=root&include_descendants=true").json()["total"] == 2
    with factory() as db:
        source(db, kb_id, "月球研究中的独特正文", name="unrelated.txt", size=1000)
        db.commit()
    found = client.get(f"/api/knowledge-bases/{kb_id}/documents", params={"q": "独特正文"}).json()
    assert [item["display_name"] for item in found["items"]] == ["unrelated.txt"]
    largest = client.get(f"/api/knowledge-bases/{kb_id}/documents?sort=size").json()["items"][0]
    assert largest["display_name"] == "unrelated.txt"


def test_worker_and_multi_library_query_use_bound_profiles(client, factory, monkeypatch):
    ids = []
    for dimension in (2, 3):
        kb = client.post("/api/knowledge-bases", json={"name": f"向量{dimension}",
            "embedding_model": f"embed-{dimension}", "embedding_dimension": dimension}).json()
        ids.append(kb["id"])
        result = client.post(f"/api/knowledge-bases/{kb['id']}/uploads",
            files={"files": ("notes.txt", f"维度{dimension}的证据".encode(), "text/plain")})
        assert result.json()["jobs"]
    settings = Settings(_env_file=None, upload_root=get_settings().upload_root, embedding_base_url="https://fake.invalid/v1",
        embedding_api_key="test", embedding_model="global-unused", embedding_dimension=7)
    requests = []

    def embed(self, texts):
        requests.append((self.settings.embedding_model, self.settings.embedding_dimension, texts))
        return [[1.0] + [0.0] * (self.settings.embedding_dimension - 1) for _ in texts]

    monkeypatch.setattr(ModelGateway, "embed", embed)
    with factory() as db:
        job_ids = list(db.scalars(select(IngestionJob.id).where(IngestionJob.kb_id.in_(ids))))
    for job_id in job_ids:
        process_ingestion_job(job_id, factory, settings)
    assert {model for model, _, _ in requests} == {"embed-2", "embed-3"}
    with factory() as db:
        vectors = db.execute(select(ChunkEmbedding, EmbeddingProfile).join(EmbeddingProfile)).all()
        assert {(profile.model_name, len(vector.embedding)) for vector, profile in vectors} == {("embed-2", 2), ("embed-3", 3)}
        requests.clear()
        found = search_knowledge(db, get_actor(db), {"query": "unrelated semantic query", "kb_ids": ids, "mode": "hybrid"}, settings)
        assert found["mode"] == "hybrid" and {item["kb_id"] for item in found["items"]} == set(ids)
        assert {(model, dimension) for model, dimension, _ in requests} == {("embed-2", 2), ("embed-3", 3)}


def test_indexed_statistics_follow_bound_active_profile_and_complete_chunk_coverage(client, factory, monkeypatch):
    import app.api.workflows as api

    settings = Settings(_env_file=None, upload_root=get_settings().upload_root, embedding_base_url="https://fake.invalid/v1",
        embedding_api_key="test", embedding_model="global-unused", embedding_dimension=7, chunk_size_tokens=128,
        chunk_overlap_tokens=16)
    monkeypatch.setattr(api, "get_settings", lambda: settings)

    def embed(self, texts):
        return [[1.0] + [0.0] * (self.settings.embedding_dimension - 1) for _ in texts]

    monkeypatch.setattr(ModelGateway, "embed", embed)
    bases, doc_ids = [], []
    for dimension in (2, 3):
        kb = client.post("/api/knowledge-bases", json={"name": f"统计库{dimension}",
            "embedding_model": f"embed-{dimension}", "embedding_dimension": dimension}).json()
        bases.append(kb)
        uploaded = client.post(f"/api/knowledge-bases/{kb['id']}/uploads", files={"files":
            ("statistics.txt", (f"第{dimension}库的真实证据。\n" * 300).encode(), "text/plain")}).json()
        doc_ids.append(uploaded["items"][0]["document"]["id"])
        process_ingestion_job(uploaded["jobs"][0]["id"], factory, settings)

    def indexed(kb_id=None):
        return client.get("/api/settings/statistics", params={"kb_id": kb_id} if kb_id else {}).json()["indexed_documents"]

    assert indexed() == 2 and indexed(bases[0]["id"]) == 1
    changed = client.patch(f"/api/knowledge-bases/{bases[0]['id']}", json={"version": bases[0]["version"],
        "embedding_model": "embed-new", "embedding_dimension": 4})
    assert changed.status_code == 200
    with factory() as db:
        assert db.get(Document, doc_ids[0]).index_status == "ready"
    assert indexed(bases[0]["id"]) == 0 and indexed() == 1
    jobs = client.post("/api/settings/rebuild-embeddings", json={"kb_id": bases[0]["id"]}).json()["jobs"]
    assert len(jobs) == 1
    process_ingestion_job(jobs[0]["id"], factory, settings)
    assert indexed(bases[0]["id"]) == 1 and indexed() == 2
    with factory() as db:
        chunks = list(db.scalars(select(DocumentChunk.id).where(DocumentChunk.document_id == doc_ids[0])))
        assert len(chunks) > 1
        profile = db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.model_name == "embed-new"))
        db.execute(delete(ChunkEmbedding).where(ChunkEmbedding.chunk_id == chunks[0], ChunkEmbedding.profile_id == profile.id))
        db.commit()
    assert indexed(bases[0]["id"]) == 0 and indexed() == 1
    with factory() as db:
        profile = db.scalar(select(EmbeddingProfile).where(EmbeddingProfile.model_name == "embed-3"))
        profile.status = "inactive"
        db.commit()
    assert indexed() == 0


def test_selected_model_snapshot_keeps_planning_private_with_real_tools(client, factory, monkeypatch, tmp_path):
    import app.api.workflows as api

    configured = Settings(_env_file=None, llm_base_url="https://controlled.invalid/v1", llm_api_key="fake", llm_model="default",
        llm_models=["selected"], llm_supports_tools=True, runtime_config_dir=tmp_path / "runtime")
    monkeypatch.setattr(api, "get_settings", lambda: configured)
    listed = client.get("/api/settings/chat-models").json()
    assert listed == {"models": ["default", "selected"], "default_model": "default", "supports_tools": True}
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    with factory() as db:
        source(db, kb_id, "课程政策规定名额28人")
        db.commit()
    chat = client.post("/api/conversations", json={"kb_id": kb_id, "scope": {"kb_ids": [kb_id]}}).json()["id"]
    invalid = client.post(f"/api/conversations/{chat}/messages", json={"content": "课程政策", "model": "unlisted"})
    assert invalid.status_code == 422
    queued = client.post(f"/api/conversations/{chat}/messages", json={"content": "课程政策", "model": "selected", "retrieval_mode": "model"})
    assert queued.status_code == 202
    with factory() as db:
        job = db.scalar(select(IngestionJob).where(IngestionJob.kind == "chat"))
        assert job.payload["model"] == "selected"
        job_id = job.id
    payloads, tool_turns = [], 0

    def response(request):
        nonlocal tool_turns
        payload = json.loads(request.content)
        payloads.append(payload)
        assert payload["model"] == "selected"
        if "tools" in payload:
            assert not payload.get("stream", False)
            tool_turns += 1
            tool_message = {"role": "assistant", "content": "我先查课程政策。" if tool_turns == 1 else "已找到相关资料。",
                "reasoning_content": "INTERNAL-SECRET"}
            if tool_turns == 1:
                tool_message["tool_calls"] = [{"id": "call-1", "type": "function",
                    "function": {"name": "search_knowledge", "arguments": '{"query":"课程政策"}'}}]
            return httpx.Response(200, json={"choices": [{"message": tool_message,
                "finish_reason": "tool_calls" if tool_turns == 1 else "stop"}]})
        else:
            assert payload["stream"] is True
            deltas = [{"content": "名额28人。[S1]", "reasoning": "INTERNAL-SECRET"}]
        events = [{"choices": [{"delta": delta}]} for delta in deltas]
        events.append({"choices": [{"delta": {}, "finish_reason": "tool_calls" if "tools" in payload and tool_turns == 1 else "stop"}]})
        body = "".join("data: " + json.dumps(event, ensure_ascii=False) + "\n\n" for event in events) + "data: [DONE]\n\n"
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    original_init = ModelGateway.__init__

    def initialize(self, settings, **kwargs):
        original_init(self, settings, transport=httpx.MockTransport(response))

    monkeypatch.setattr(ModelGateway, "__init__", initialize)
    process_chat_job(job_id, factory, configured.model_copy(update={"llm_model": "changed-default"}))
    with factory() as db:
        message = db.get(Message, queued.json()["id"])
        assert message.status == "completed"
        assert message.content == "名额28人。[S1]"
        tokens = list(db.scalars(select(ConversationEvent).where(ConversationEvent.conversation_id == chat,
            ConversationEvent.type == "token").order_by(ConversationEvent.sequence)))
        assert "".join(event.data["token"] for event in tokens) == message.content
        events = str([event.data for event in db.scalars(select(ConversationEvent))])
        assert "INTERNAL-SECRET" not in events
        assert "我先查课程政策" not in events and "已找到相关资料" not in events
        activity = next(step for step in message.retrieval["execution"] if step["stage"] == "tool_activity")
        assert activity["tool_name"] == "search_knowledge" and activity["status"] == "completed"
    assert tool_turns == 2 and len(payloads) == 3
