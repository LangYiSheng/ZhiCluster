"""Catalog discovery uses fake transports, with no generation or persistence."""

import json
from types import SimpleNamespace

import httpx
import pytest

from app.ai.gateway import ModelCatalogError, ModelGateway
from app.core.config import Settings
from app.db.models import AppConfiguration
from app.schemas.settings import ConfigurationSave
from app.services.runtime_config import get_runtime_settings, save_configuration


def gateway(transport, **overrides):
    settings = SimpleNamespace(**{
        "llm_base_url": "https://chat.invalid/v1/", "llm_api_key": "chat-test-secret", "llm_model": "",
        "llm_timeout_seconds": 120, "embedding_base_url": "https://embed.invalid/openai/v1",
        "embedding_api_key": "embed-test-secret", "embedding_model": "", **overrides,
    })
    return ModelGateway(settings, transport=httpx.MockTransport(transport))


def test_catalog_get_needs_no_model_and_preserves_provider_path_and_key():
    requests = []

    def respond(request):
        requests.append(request)
        assert request.method == "GET"
        assert request.content == b""
        prefix = "chat" if request.url.host == "chat.invalid" else "embed"
        assert request.headers["Authorization"] == f"Bearer {prefix}-test-secret"
        return httpx.Response(200, json={"data": [
            {"id": "zeta", "owned_by": "ignored"}, {"id": "Alpha"}, {"id": "zeta"},
            {"id": "  beta  "}, {"id": 3}, {"id": "bad\nidentifier"}, {"id": ""}, None,
        ]})

    models = gateway(respond)
    assert models.list_models("llm") == ["Alpha", "beta", "zeta"]
    assert models.list_models("embedding") == ["Alpha", "beta", "zeta"]
    assert [str(request.url) for request in requests] == [
        "https://chat.invalid/v1/models", "https://embed.invalid/openai/v1/models",
    ]


@pytest.mark.parametrize(("status", "code"), [
    (401, "model_list_auth_failed"), (403, "model_list_auth_failed"),
    (404, "model_list_unsupported"), (405, "model_list_unsupported"),
    (429, "model_list_rate_limited"), (500, "model_list_provider_error"),
    (302, "model_list_provider_error"),
])
def test_catalog_errors_never_echo_body_or_follow_redirects(status, code):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(status, headers={"location": "https://other.invalid/private"},
                              json={"error": "chat-test-secret provider-private-debug"})

    with pytest.raises(ModelCatalogError) as error:
        gateway(respond, llm_max_retries=4).list_models("llm")
    assert error.value.code == code
    assert "test-secret" not in str(error.value)
    assert "provider-private-debug" not in str(error.value)
    assert "other.invalid" not in str(error.value)
    assert len(requests) == 1


@pytest.mark.parametrize("body", ["not-json", "[]", '{"models": []}', '{"data": {}}',
                                  '{"data": [{"id": 42}, {"id": ""}]}'])
def test_catalog_rejects_invalid_json_structure_and_identifiers(body):
    with pytest.raises(ModelCatalogError) as error:
        gateway(lambda _: httpx.Response(200, text=body)).list_models("llm")
    assert error.value.code == "model_list_invalid_response"


def test_catalog_rejects_large_response_and_accepts_empty_list():
    models = gateway(lambda _: httpx.Response(200, content=b"x" * (ModelGateway.MODEL_LIST_MAX_BYTES + 1)))
    with pytest.raises(ModelCatalogError) as error:
        models.list_models("llm")
    assert error.value.code == "model_list_invalid_response"
    assert gateway(lambda _: httpx.Response(200, json={"data": []})).list_models("llm") == []


@pytest.mark.parametrize(("exception", "code", "status"), [
    (httpx.ReadTimeout, "model_list_timeout", 504),
    (httpx.ConnectError, "model_list_network_error", 502),
])
def test_catalog_connection_failures_are_clear_and_redacted(exception, code, status):
    def respond(request):
        assert request.extensions["timeout"]["read"] <= 15
        raise exception("chat-test-secret and private provider details", request=request)

    with pytest.raises(ModelCatalogError) as error:
        gateway(respond).list_models("llm")
    assert error.value.code == code
    assert error.value.status == status
    assert "test-secret" not in str(error.value)


@pytest.fixture
def catalog_base(tmp_path, monkeypatch):
    import app.api.workflows as api

    base = Settings(_env_file=None, app_env="test", runtime_config_dir=tmp_path / "runtime",
                    llm_base_url="", llm_model="", llm_api_key="",
                    embedding_base_url="", embedding_model="", embedding_api_key="")
    monkeypatch.setattr(api, "get_settings", lambda: base)
    return base


def save_catalog_configuration(factory, base):
    with factory() as db:
        save_configuration(db, ConfigurationSave(revision=0,
            llm={"base_url": "https://chat.invalid/v1", "api_key": "saved-chat-test-secret"},
            embedding={"base_url": "https://embed.invalid/v1", "api_key": "saved-embed-test-secret"}), base)
        db.commit()


@pytest.mark.parametrize("scope", ["llm", "embedding"])
def test_catalog_uses_selected_provider_and_stored_key_without_saving(client, factory, catalog_base, monkeypatch, scope):
    import app.api.workflows as api

    save_catalog_configuration(factory, catalog_base)
    before = client.get("/api/settings/config").json()
    requests = []

    def respond(request):
        requests.append(request)
        selected = "chat" if scope == "llm" else "embed"
        assert request.url.host == f"{selected}.invalid"
        assert request.headers["Authorization"] == f"Bearer saved-{selected}-test-secret"
        return httpx.Response(200, json={"data": [{"id": "catalog-model", "secret_debug": "ignored"}]})

    monkeypatch.setattr(api, "ModelGateway", lambda settings: ModelGateway(settings, transport=httpx.MockTransport(respond)))
    other = "embedding" if scope == "llm" else "llm"
    response = client.post("/api/settings/models", json={"scope": scope, "draft": {
        scope: {"api_key": ""}, other: {"base_url": "https://never-contact.invalid/v1", "api_key": "other-test-secret"},
        "processing": {"chunk_size_tokens": 128, "chunk_overlap_tokens": 128},
    }})
    assert response.status_code == 200, response.text
    assert response.json() == {"models": [{"id": "catalog-model"}]}
    assert len(requests) == 1
    assert client.get("/api/settings/config").json() == before
    assert "test-secret" not in response.text


def test_catalog_draft_address_and_key_are_not_persisted(client, factory, catalog_base, monkeypatch):
    import app.api.workflows as api

    save_catalog_configuration(factory, catalog_base)

    def respond(request):
        assert str(request.url) == "https://draft.invalid/compatible/v1/models"
        assert request.headers["Authorization"] == "Bearer draft-test-secret"
        return httpx.Response(200, json={"data": []})

    monkeypatch.setattr(api, "ModelGateway", lambda settings: ModelGateway(settings, transport=httpx.MockTransport(respond)))
    result = client.post("/api/settings/models", json={"scope": "llm", "draft": {
        "llm": {"base_url": "  https://draft.invalid/compatible/v1/  ", "api_key": "draft-test-secret"}}})
    assert result.status_code == 200, result.text
    assert result.json()["models"] == []
    assert result.json()["message"]
    with factory() as db:
        row = db.get(AppConfiguration, "runtime")
        assert row.revision == 1
        assert "draft-test-secret" not in json.dumps(row.values)
        assert "draft-test-secret" not in json.dumps(row.secrets)
        saved = get_runtime_settings(db, catalog_base)
        assert saved.llm_api_key.get_secret_value() == "saved-chat-test-secret"
        assert saved.llm_base_url == "https://chat.invalid/v1"
        assert saved.llm_model == ""


@pytest.mark.parametrize("key_patch", [{}, {"api_key": ""}, {"api_key": None}])
def test_catalog_never_sends_stored_key_to_changed_endpoint(client, factory, catalog_base, monkeypatch, key_patch):
    import app.api.workflows as api

    save_catalog_configuration(factory, catalog_base)

    def no_gateway(*_):
        pytest.fail("changed endpoint without explicit key must not reach a provider")

    monkeypatch.setattr(api, "ModelGateway", no_gateway)
    response = client.post("/api/settings/models", json={"scope": "llm", "draft": {
        "llm": {"base_url": "https://new.invalid/v1", **key_patch}}})
    assert response.status_code == 422
    assert response.json()["code"] == "model_list_key_required"
    assert "test-secret" not in response.text


def test_catalog_same_normalized_endpoint_reuses_key_and_error_is_redacted(client, factory, catalog_base, monkeypatch):
    import app.api.workflows as api

    save_catalog_configuration(factory, catalog_base)

    def respond(request):
        assert request.headers["Authorization"] == "Bearer saved-chat-test-secret"
        return httpx.Response(401, json={"error": "saved-chat-test-secret private-debug"})

    monkeypatch.setattr(api, "ModelGateway", lambda settings: ModelGateway(settings, transport=httpx.MockTransport(respond)))
    response = client.post("/api/settings/models", json={"scope": "llm", "draft": {
        "llm": {"base_url": " https://chat.invalid/v1/ "}}})
    assert response.status_code == 502
    assert response.json()["code"] == "model_list_auth_failed"
    assert "test-secret" not in response.text
    assert "private-debug" not in response.text
    assert client.get("/api/settings/config").json()["revision"] == 1


def test_catalog_clear_key_and_missing_credentials_do_not_make_requests(client, factory, catalog_base, monkeypatch):
    save_catalog_configuration(factory, catalog_base)

    def no_request(*_, **__):
        pytest.fail("unconfigured catalog must not send a request")

    monkeypatch.setattr(httpx.Client, "stream", no_request)
    response = client.post("/api/settings/models", json={"scope": "llm", "draft": {"llm": {"clear_api_key": True}}})
    assert response.status_code == 422
    assert response.json()["code"] == "model_list_unconfigured"
    assert client.get("/api/settings/config").json()["llm"]["api_key_configured"] is True


@pytest.mark.parametrize("body", [{}, {"scope": "tool_calling"}, {"scope": "llm", "draft": {
    "llm": {"base_url": "https://user:private-secret@provider.invalid/v1", "api_key": "private-secret"}}}])
def test_catalog_invalid_request_is_redacted(client, catalog_base, body):
    response = client.post("/api/settings/models", json=body)
    assert response.status_code == 422
    assert "private-secret" not in response.text
