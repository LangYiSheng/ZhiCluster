"""Read-only profiler target, response-equivalence and provenance safeguards."""

import hashlib
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("retrieval_profile", Path(__file__).resolve().parents[2] / "scripts/retrieval_profile.py")
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


@pytest.mark.parametrize("url,dedicated", [
    ("postgresql+psycopg://benchmark@127.0.0.1:25432/zhicluster", None),
    ("postgresql://benchmark@localhost:25432/zhicluster", None),
    ("postgresql+psycopg://benchmark@[::1]:25432/zhicluster", None),
    ("postgresql+psycopg://benchmark@127.0.0.1:5432/zhicluster_retrieval_test", "zhicluster_retrieval_test"),
])
def test_profiler_only_accepts_evaluation_or_explicit_dedicated_targets(url, dedicated):
    parsed, public = profile.validate_profile_target(url, dedicated)
    assert parsed.drivername == "postgresql+psycopg"
    assert set(public) == {"host", "port", "database"}


@pytest.mark.parametrize("url,dedicated", [
    ("postgresql+psycopg://benchmark@127.0.0.1:55432/zhicluster", None),
    ("postgresql+psycopg://benchmark@127.0.0.1:5432/zhicluster", "zhicluster"),
    ("postgresql+psycopg://benchmark@127.0.0.1:5432/zhicluster_retrieval_test", None),
    ("postgresql+psycopg://benchmark@127.0.0.1:5432/zhicluster_retrieval_test", "other_test"),
    ("postgresql+psycopg://benchmark@database.example:25432/zhicluster", None),
    ("sqlite://", None),
    ("invalid connection text", None),
])
def test_profiler_rejects_ordinary_implicit_remote_and_non_postgres_targets(url, dedicated):
    with pytest.raises(ValueError):
        profile.validate_profile_target(url, dedicated)


@pytest.mark.parametrize("key", ["host", "HOST", "hostaddr", "port", "dbname", "database", "service", "servicefile", "options"])
def test_query_parameters_cannot_bypass_the_target_guard(key):
    with pytest.raises(ValueError, match="overridden"):
        profile.validate_profile_target(f"postgresql+psycopg://benchmark@127.0.0.1:25432/zhicluster?{key}=override")


def test_response_signature_ignores_only_timing():
    response = {"items": [{"chunk_id": "a", "score": .2}], "total": 1, "elapsed_ms": 10,
                "mode": "keyword", "reranking": {"status": "skipped"}}
    assert profile.response_signature(response) == profile.response_signature({**response, "elapsed_ms": 200})
    assert profile.response_signature(response) != profile.response_signature({**response, "items": []})
    assert profile.response_signature(response) != profile.response_signature({**response, "reranking": {"status": "fallback"}})


def test_snapshot_provenance_rejects_changed_or_missing_sources(tmp_path):
    directory = tmp_path / "snapshot"
    directory.mkdir()
    hashes = {}
    for name in ("terms", "ranking", "search"):
        content = f"# original {name}\n".encode()
        (directory / f"{name}.py").write_bytes(content)
        hashes[name] = hashlib.sha256(content).hexdigest()
    assert profile.unchanged_sources({"baseline": directory}, {"baseline": hashes})
    (directory / "search.py").write_text("# changed\n", encoding="utf-8")
    assert not profile.unchanged_sources({"baseline": directory}, {"baseline": hashes})
    (directory / "ranking.py").unlink()
    assert not profile.unchanged_sources({"baseline": directory}, {"baseline": hashes})
