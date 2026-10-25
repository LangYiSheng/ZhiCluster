"""Format plugins reach uploads, and legacy conversion uses bounded UNO properties."""

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.core.config import Settings, get_settings
from app.db.models import Document
from app.ingestion import format_registry, legacy_formats, office_bridge
from app.ingestion.format_registry import FormatRegistry, FormatSpec, get_registry
from app.ingestion.parser_types import ParsedDocument, ParsedSection, ParseError
from app.ingestion.parsers import parse_document, validate_content
from app.worker.pipeline import process_ingestion_job


def test_format_catalog_is_complete_and_includes_live_dependency_and_size_information(client):
    response = client.get("/api/settings/file-formats")
    assert response.status_code == 200
    catalog = response.json()
    assert {entry["extension"] for entry in catalog["formats"]} == {
        "pdf", "docx", "md", "txt", "pptx", "xlsx", "csv", "html", "htm", "json", "jsonl", "doc", "xls", "ppt", "epub"}
    for entry in catalog["formats"]:
        spec = get_registry().get(entry["extension"])
        assert entry["mime_type"] == spec.mime_type and entry["preview"] == spec.preview
        assert entry["available"] == spec.available()[0]
        if not entry["available"]:
            assert entry["reason"]
    assert catalog["limits"]["max_file_size_bytes"] > 0 and catalog["limits"]["max_batch_files"] > 0


def test_registering_a_format_plugin_enables_real_upload_validation_and_worker_without_whitelists(client, factory, monkeypatch):
    registry = FormatRegistry()

    def validate(data, limit):
        if not data.startswith(b"plugin:"):
            raise ParseError("Missing plugin signature")

    def parse(data):
        text = data.decode()
        return ParsedDocument([ParsedSection("Plugin", 1, text, {"line_start": 1, "line_end": 1}, 0, len(text))], text)

    registry.register(FormatSpec("plugin", "Test format", "text/x-zhicluster-plugin", validate, parse))
    monkeypatch.setattr(format_registry, "get_registry", lambda: registry)
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    response = client.post(f"/api/knowledge-bases/{kb_id}/uploads", files={"files":
        ("evidence.plugin", b"plugin: real uploaded evidence", "text/x-zhicluster-plugin")})
    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["document"]["mime_type"] == "text/x-zhicluster-plugin"
    assert response.json()["items"][0]["document"]["preview_type"] == "text"
    job_id = response.json()["jobs"][0]["id"]
    process_ingestion_job(job_id, factory, Settings(_env_file=None, upload_root=get_settings().upload_root))
    with factory() as db:
        document = db.scalar(select(Document))
        assert document.parse_status == "ready"
    assert client.get("/api/settings/file-formats").json()["formats"][0]["extension"] == "plugin"


def test_json_and_csv_uploads_use_registry_mime_and_reject_spoofed_content(client):
    kb_id = client.get("/api/knowledge-bases").json()[0]["id"]
    response = client.post(f"/api/knowledge-bases/{kb_id}/uploads", files=[
        ("files", ("records.json", b'{"value":23}', "application/json")),
        ("files", ("rows.csv", b"name,value\nalpha,23\n", "text/csv")),
        ("files", ("spoof.json", b"%PDF-fake", "application/json")),
        ("files", ("wrong-mime.json", b'{"value":24}', "application/pdf")),
    ])
    assert [item["status"] for item in response.json()["items"]] == ["queued", "queued", "error", "error"]
    assert [item["document"]["mime_type"] for item in response.json()["items"][:2]] == ["application/json", "text/csv"]


def test_legacy_unavailable_is_an_explicit_dependency_error(monkeypatch):
    monkeypatch.setattr(legacy_formats, "_office_tools", lambda: (None, None, "需要 LibreOffice UNO"))
    assert legacy_formats.office_availability() == (False, "需要 LibreOffice UNO")
    with pytest.raises(ParseError, match="LibreOffice UNO"):
        legacy_formats.parse_doc(b"not converted")


def test_converter_timeout_kills_the_process_group_and_removes_temporary_input(monkeypatch):
    monkeypatch.setattr(legacy_formats, "_office_tools", lambda: ("/fake/soffice", "/fake/python", None))
    paths, killed = [], []

    class Process:
        pid = 987654

        def __init__(self, args, **options):
            self.calls = 0
            paths.append(Path(args[3]))
            assert paths[-1].read_bytes() == b"original bytes"
            assert options["start_new_session"] is True and "shell" not in options

        def communicate(self, **options):
            self.calls += 1
            if self.calls == 1:
                raise subprocess.TimeoutExpired("office", options["timeout"])
            return b"", b""

    monkeypatch.setattr(legacy_formats.subprocess, "Popen", Process)
    monkeypatch.setattr(legacy_formats.os, "killpg", lambda *args: killed.append(args), raising=False)
    monkeypatch.setattr(legacy_formats.signal, "SIGKILL", 9, raising=False)
    with pytest.raises(ParseError, match="超时"):
        legacy_formats.convert_office(b"original bytes", "doc")
    assert killed == [(987654, 9)] and not paths[0].parent.exists()


def test_uno_bridge_loads_local_copy_readonly_without_macros_or_link_updates(monkeypatch, tmp_path):
    import sys

    loaded, stored, started = [], [], []

    class Document:
        def storeToURL(self, uri, properties):
            stored.append((uri, {prop.Name: prop.Value for prop in properties}))

        def close(self, value):
            assert value is True

    class Desktop:
        def loadComponentFromURL(self, uri, frame, flags, properties):
            loaded.append((uri, {prop.Name: prop.Value for prop in properties}))
            return Document()

        def terminate(self):
            return True

    remote = SimpleNamespace(ServiceManager=SimpleNamespace(createInstanceWithContext=lambda *_: Desktop()))
    resolver = SimpleNamespace(resolve=lambda *_: remote)
    local = SimpleNamespace(ServiceManager=SimpleNamespace(createInstanceWithContext=lambda *_: resolver))
    uno = SimpleNamespace(getComponentContext=lambda: local, createUnoStruct=lambda *_: SimpleNamespace(),
        getConstantByName=lambda name: name)
    monkeypatch.setitem(sys.modules, "uno", uno)

    class Process:
        def __init__(self, args, **options):
            started.append(args)

        def poll(self):
            return 0

    monkeypatch.setattr(office_bridge.subprocess, "Popen", Process)
    source, target, profile = tmp_path / "source.doc", tmp_path / "target.docx", tmp_path / "profile"
    office_bridge.convert("/usr/bin/soffice", source, target, profile)
    assert loaded[0][0] == source.as_uri()
    assert loaded[0][1] == {"Hidden": True, "ReadOnly": True, "Silent": True,
        "MacroExecutionMode": "com.sun.star.document.MacroExecMode.NEVER_EXECUTE",
        "UpdateDocMode": "com.sun.star.document.UpdateDocMode.NO_UPDATE"}
    assert stored[0][1]["FilterName"] == "Office Open XML Text"
    assert any(argument.startswith("-env:UserInstallation=") for argument in started[0])
    assert any(argument.startswith("--accept=pipe,name=zhicluster_") for argument in started[0])


def test_legacy_invalid_ole_signatures_and_macro_streams_are_rejected(monkeypatch):
    import olefile

    with pytest.raises(ParseError):
        legacy_formats.validate_doc(b"not an OLE document")

    class Ole:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def listdir(self):
            return [["Macros", "VBA", "Module1"]]

    monkeypatch.setattr(olefile, "OleFileIO", Ole)
    with pytest.raises(ParseError, match="宏"):
        legacy_formats.validate_doc(legacy_formats.OLE_MAGIC + b"test")


def test_supported_extensions_are_registry_derived_and_text_anchors_stay_exact(tmp_path):
    from app.ingestion.parsers import SUPPORTED_EXTENSIONS

    assert SUPPORTED_EXTENSIONS == get_registry().extensions
    path = tmp_path / "source.txt"
    path.write_bytes(b"actual source")
    validate_content(path.read_bytes(), "txt")
    parsed = parse_document(path)
    assert parsed.plain_text == "actual source"
