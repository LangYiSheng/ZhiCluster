"""Runtime settings use fake credentials and provider transports exclusively."""

import json
import os
import signal
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import httpx
import pytest

from app.ai.gateway import ModelGateway
from app.core.config import Settings
from app.db.models import AppConfiguration
from app.schemas.settings import ConfigurationSave
from app.services.runtime_config import (
    _cipher,
    get_runtime_settings,
    read_configuration,
    save_configuration,
)


@pytest.fixture
def runtime_base(tmp_path, monkeypatch):
    import app.api.workflows as api

    base = Settings(_env_file=None, app_env="test", runtime_config_dir=tmp_path / "runtime",
                    llm_base_url="", llm_model="", llm_api_key="",
                    embedding_base_url="", embedding_model="", embedding_api_key="")
    monkeypatch.setattr(api, "get_settings", lambda: base)
    return base


def save(db, base, revision=0, **values):
    result = save_configuration(db, ConfigurationSave(revision=revision, **values), base)
    db.commit()
    return result


def test_web_save_persists_masks_and_preserves_independent_keys(client, factory, runtime_base):
    initial = client.get("/api/settings/config").json()
    assert initial["revision"] == 0
    response = client.put("/api/settings/config", json={"revision": 0,
        "llm": {"base_url": "http://localhost:9100/v1/", "model": "chat-one", "api_key": "chat-test-secret"},
        "embedding": {"base_url": "http://localhost:9200/v1", "model": "embed-one", "api_key": "embed-test-secret", "dimension": 3},
        "processing": {"chunk_size_tokens": 900}})
    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 1
    assert response.json()["llm"]["base_url"] == "http://localhost:9100/v1"
    assert response.json()["llm"]["api_key_configured"] is True
    assert "test-secret" not in response.text
    assert client.get("/api/settings/config").json() == response.json()
    with factory() as db:
        row = db.get(AppConfiguration, "runtime")
        assert "test-secret" not in json.dumps(row.values)
        assert "test-secret" not in json.dumps(row.secrets)
        snapshot = get_runtime_settings(db, runtime_base)
        assert snapshot.llm_api_key.get_secret_value() == "chat-test-secret"
        assert snapshot.embedding_api_key.get_secret_value() == "embed-test-secret"
        assert snapshot.chunk_size_tokens == 900
    assert client.get("/api/settings/model-status").json()["llm"] == {"configured": True, "model": "chat-one"}
    key = runtime_base.runtime_config_dir / "master.key"
    assert key.exists()
    if os.name != "nt":
        assert key.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize("key_value", [None, ""])
def test_empty_and_null_keys_keep_and_explicit_clear_survives_env_defaults(factory, runtime_base, key_value):
    from pydantic import SecretStr

    runtime_base.llm_api_key = SecretStr("env-default-secret")
    with factory() as db:
        save(db, runtime_base)
        first = get_runtime_settings(db, runtime_base)
        assert first.llm_api_key.get_secret_value() == "env-default-secret"
        save(db, runtime_base, 1, llm={"api_key": key_value, "model": "changed-model"})
        assert get_runtime_settings(db, runtime_base).llm_api_key.get_secret_value() == "env-default-secret"
        save(db, runtime_base, 2, llm={"clear_api_key": True})
        assert get_runtime_settings(db, runtime_base).llm_api_key.get_secret_value() == ""
        assert read_configuration(db, runtime_base)["llm"]["api_key_configured"] is False
        save(db, runtime_base, 3, llm={"api_key": "replacement-secret"})
        assert get_runtime_settings(db, runtime_base).llm_api_key.get_secret_value() == "replacement-secret"
        assert first.llm_api_key.get_secret_value() == "env-default-secret"


def test_stale_revision_does_not_overwrite_current_config(client, runtime_base):
    assert client.put("/api/settings/config", json={"revision": 0, "llm": {"model": "first"}}).status_code == 200
    conflict = client.put("/api/settings/config", json={"revision": 0, "llm": {"model": "stale"}})
    assert conflict.status_code == 409
    assert client.get("/api/settings/config").json()["llm"]["model"] == "first"


@pytest.mark.parametrize("draft", [
    {"database_url": "postgresql://invalid"},
    {"llm": {"base_url": "https://user:private-password@example.test/v1"}},
    {"llm": {"base_url": "https://example.test/v1?key=private-password"}},
    {"llm": {"base_url": "file:///private-password"}},
    {"llm": {"base_url": "https://example.test:bad-port"}},
    {"llm": {"api_key": "private-password", "clear_api_key": True}},
    {"llm": {"api_key": "private-password\nwrong"}},
    {"llm": {"timeout_seconds": 0}},
    {"embedding": {"dimension": 0}},
    {"embedding": {"dimension": 16001}},
    {"processing": {"max_concurrent_model_calls": 17}},
    {"processing": {"chunk_size_tokens": 128, "chunk_overlap_tokens": 128}},
])
def test_validation_is_bounded_and_never_echoes_secrets(client, runtime_base, draft):
    result = client.put("/api/settings/config", json={"revision": 0, **draft})
    assert result.status_code == 422, result.text
    assert "private-password" not in result.text
    assert client.get("/api/settings/config").json()["revision"] == 0


@pytest.mark.parametrize("scope", ["llm", "embedding", "tool_calling"])
def test_draft_scope_uses_kept_key_without_saving_or_other_probes(client, factory, runtime_base, monkeypatch, scope):
    import app.api.workflows as api

    with factory() as db:
        save(db, runtime_base,
             llm={"base_url": "https://chat.invalid/v1", "model": "saved", "api_key": "chat-fake-secret"},
             embedding={"base_url": "https://embed.invalid/v1", "model": "saved", "api_key": "embed-fake-secret", "dimension": 3})
    requests = []

    def respond(request):
        requests.append(request)
        payload = json.loads(request.content)
        if scope == "embedding":
            assert request.url.host == "embed.invalid"
            assert request.headers["Authorization"] == "Bearer embed-fake-secret"
            return httpx.Response(200, json={"data": [{"index": 0, "embedding": [1, 2, 3]}]})
        assert request.headers["Authorization"] == "Bearer chat-fake-secret"
        assert payload["model"] == "draft-only"
        message = {"content": "OK"} if scope == "llm" else {"tool_calls": [{"function": {"name": "capability_probe"}}]}
        return httpx.Response(200, json={"choices": [{"message": message}]})

    monkeypatch.setattr(api, "ModelGateway", lambda settings: ModelGateway(settings, transport=httpx.MockTransport(respond)))
    result = client.post("/api/settings/test-models", json={"scope": scope, "draft": {"llm": {"model": "draft-only", "api_key": ""}}})
    assert result.status_code == 200, result.text
    assert set(result.json()) == {scope}
    assert result.json()[scope]["ok"] is True
    assert result.json()[scope]["elapsed_ms"] >= 0
    assert "fake-secret" not in result.text
    assert len(requests) == 1
    assert client.get("/api/settings/config").json()["llm"]["model"] == "saved"
    assert client.get("/api/settings/config").json()["revision"] == 1


def test_legacy_empty_test_body_and_explicit_clear_draft(client, runtime_base):
    response = client.post("/api/settings/test-models")
    assert response.status_code == 200
    assert set(response.json()) == {"llm", "embedding", "tool_calling"}
    assert all(not result["ok"] for result in response.json().values())


def test_clear_key_draft_is_not_sent_and_does_not_change_saved_key(client, runtime_base, monkeypatch):
    response = client.put("/api/settings/config", json={"revision": 0, "llm": {
        "model": "fake-model", "base_url": "https://never-contact.invalid/v1", "api_key": "saved-fake-secret"}})
    assert response.status_code == 200

    def no_request(*args, **kwargs):
        pytest.fail("clear-key draft must not send any provider request")

    monkeypatch.setattr(httpx.Client, "post", no_request)
    result = client.post("/api/settings/test-models", json={"scope": "llm", "draft": {"llm": {"clear_api_key": True}}})
    assert result.json()["llm"]["configured"] is False
    assert result.json()["llm"]["ok"] is False
    current = client.get("/api/settings/config").json()
    assert current["revision"] == 1
    assert current["llm"]["api_key_configured"] is True


def test_agent_creation_reads_saved_runtime_settings(client, factory, runtime_base, monkeypatch):
    import app.api.agent as api

    monkeypatch.setattr(api, "get_settings", lambda: runtime_base)
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    assert client.post("/api/agent/runs", json={"kb_id": kb_id, "goal": "整理知识库"}).status_code == 503
    assert client.put("/api/settings/config", json={"revision": 0, "llm": {
        "model": "new-model", "base_url": "https://fake.invalid/v1", "api_key": "saved-fake-secret"}}).status_code == 200
    created = client.post("/api/agent/runs", json={"kb_id": kb_id, "goal": "整理知识库"})
    assert created.status_code == 201, created.text
    assert created.json()["status"] == "queued"


def test_agent_planner_and_search_tool_share_supplied_job_snapshot(factory, runtime_base, monkeypatch):
    import app.agent.planner as planner
    import app.retrieval.search as retrieval
    from app.services.permissions import get_actor

    captured = {}
    with factory() as db:
        save(db, runtime_base, llm={"model": "old-chat", "base_url": "https://fake.invalid/v1", "api_key": "old-fake-key"},
             embedding={"model": "old-embedding"})
        snapshot = get_runtime_settings(db, runtime_base)
        save(db, runtime_base, 1, llm={"model": "new-chat", "api_key": "new-fake-key"}, embedding={"model": "new-embedding"})
        actor = get_actor(db)
        from sqlalchemy import select

        from app.db.models import KnowledgeBase

        kb = db.scalar(select(KnowledgeBase).where(KnowledgeBase.owner_id == actor.id))

        def model(**options):
            captured.update(options)
            return "fake-model"

        def search(_db, _actor, _request, settings):
            captured["tool_embedding_model"] = settings.embedding_model
            return {"items": []}

        def agent(**options):
            options["tools"][[tool.name for tool in options["tools"]].index("search_knowledge")].invoke({"query": "资料"})
            return SimpleNamespace(invoke=lambda *args: {"structured_response": {"summary": "假模型计划", "operations": [{
                "type": "create_folder", "description": "创建目录", "params": {"name": "测试目录"}}]}})

        monkeypatch.setattr(planner, "ChatOpenAI", model)
        monkeypatch.setattr(planner, "create_agent", agent)
        monkeypatch.setattr(retrieval, "search_knowledge", search)
        planner.plan_with_model(db, actor, kb.id, "整理", lambda *_: None, {}, settings=snapshot)
    assert captured["model"] == "old-chat"
    assert captured["api_key"] == "old-fake-key"
    assert captured["tool_embedding_model"] == "old-embedding"


def test_missing_or_wrong_master_key_fails_closed(client, factory, runtime_base):
    with factory() as db:
        save(db, runtime_base, llm={"api_key": "saved-secret"})
    path = runtime_base.runtime_config_dir / "master.key"
    original = path.read_bytes()
    path.unlink()
    response = client.get("/api/settings/config")
    assert response.status_code == 503
    assert response.json()["code"] == "configuration_key_unavailable"
    assert not path.exists()
    from cryptography.fernet import Fernet

    path.write_bytes(Fernet.generate_key())
    response = client.get("/api/settings/config")
    assert response.status_code == 503
    assert response.json()["code"] == "configuration_decryption_failed"
    assert "saved-secret" not in response.text
    path.write_bytes(original)
    assert client.get("/api/settings/config").status_code == 200


def test_atomic_key_creation_across_concurrent_initializers(tmp_path):
    with ThreadPoolExecutor(max_workers=8) as pool:
        ciphers = list(pool.map(lambda _: _cipher(tmp_path / "runtime", create=True), range(24)))
    token = ciphers[0].encrypt(b"concurrent-secret")
    assert all(cipher.decrypt(token) == b"concurrent-secret" for cipher in ciphers)
    assert list((tmp_path / "runtime").iterdir()) == [tmp_path / "runtime" / "master.key"]


def test_worker_reads_next_job_snapshot_and_keeps_active_snapshot(factory, runtime_base, monkeypatch):
    import app.worker.main as worker

    with factory() as db:
        save(db, runtime_base, llm={"model": "before-save"})
    handlers = {}
    snapshots = []
    monkeypatch.setattr(worker, "SessionLocal", factory)
    monkeypatch.setattr(worker, "get_settings", lambda: runtime_base)
    monkeypatch.setattr(worker.signal, "signal", lambda number, handler: handlers.update({number: handler}))

    class Scheduler:
        busy = False

        def __init__(self, owner, settings, session_factory, dispatch):
            assert session_factory is factory

        def poll(self, settings):
            snapshots.append(settings)
            if len(snapshots) == 1:
                with factory() as db:
                    save(db, runtime_base, 1, llm={"model": "after-save"})
                assert settings.llm_model == "before-save"
            else:
                handlers[signal.SIGTERM]()

        def shutdown(self):
            pass

    monkeypatch.setattr(worker, "WorkerScheduler", Scheduler)
    worker.run_worker()
    assert [snapshot.llm_model for snapshot in snapshots] == ["before-save", "after-save"]
    assert runtime_base.llm_model == ""
