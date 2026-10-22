"""Opt-in PostgreSQL proof on a dedicated settings test database only."""

import json
import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from sqlalchemy import create_engine, delete
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.core.errors import AppError
from app.db.models import AppConfiguration
from app.schemas.settings import ConfigurationSave
from app.services.runtime_config import get_runtime_settings, read_configuration, save_configuration

TEST_URL = os.getenv("PG_SETTINGS_TEST_URL", "")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="set PG_SETTINGS_TEST_URL to isolated zhicluster_settings_test")


@pytest.fixture(scope="module")
def pg_sessions():
    assert make_url(TEST_URL).database == "zhicluster_settings_test", "Refusing a non-test database"
    environment = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "USERPROFILE", "TEMP", "TMP") if key in os.environ}
    environment.update(DATABASE_URL=TEST_URL, APP_ENV="test", PYTHONIOENCODING="utf-8")
    migration = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"],
                               cwd=Path(__file__).resolve().parents[1], env=environment,
                               capture_output=True, text=True, encoding="utf-8")
    assert migration.returncode == 0, migration.stdout + migration.stderr
    engine = create_engine(TEST_URL, pool_pre_ping=True)
    yield sessionmaker(engine, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def pg_runtime(pg_sessions, tmp_path):
    with pg_sessions() as db:
        db.execute(delete(AppConfiguration))
        db.commit()
    base = Settings(_env_file=None, database_url=TEST_URL, runtime_config_dir=tmp_path / "runtime",
                    llm_model="env-model", llm_api_key="env-fake-secret",
                    embedding_api_key="", embedding_base_url="", embedding_model="")
    yield pg_sessions, base
    with pg_sessions() as db:
        db.execute(delete(AppConfiguration))
        db.commit()


@pytest.mark.parametrize("starting_revision", [0, 1])
def test_postgres_simultaneous_writes_have_exactly_one_winner(pg_runtime, monkeypatch, starting_revision):
    import app.services.runtime_config as service

    sessions, base = pg_runtime
    if starting_revision:
        with sessions() as db:
            save_configuration(db, ConfigurationSave(revision=0), base)
            db.commit()
    barrier = threading.Barrier(2)
    original = service._row

    def concurrent_read(db):
        row = original(db)
        barrier.wait(timeout=10)
        return row

    monkeypatch.setattr(service, "_row", concurrent_read)

    def writer(model):
        with sessions() as db:
            try:
                save_configuration(db, ConfigurationSave(revision=starting_revision, llm={"model": model}), base)
                db.commit()
                return "saved", model
            except AppError as error:
                db.rollback()
                return error.code, model

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(writer, ["first-writer", "second-writer"]))
    assert sorted(status for status, _ in results) == ["configuration_conflict", "saved"]
    monkeypatch.setattr(service, "_row", original)
    with sessions() as db:
        current = read_configuration(db, base)
        assert current["revision"] == starting_revision + 1
        assert current["llm"]["model"] == next(model for status, model in results if status == "saved")


def test_postgres_cross_process_refresh_and_original_snapshot(pg_runtime):
    sessions, base = pg_runtime
    with sessions() as db:
        save_configuration(db, ConfigurationSave(revision=0, llm={"model": "persisted-one"}), base)
        db.commit()
        active = get_runtime_settings(db, base)

    code = """
import json, os
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app.core.config import Settings
from app.services.runtime_config import get_runtime_settings
base = Settings(_env_file=None, runtime_config_dir=os.environ['RUNTIME_CONFIG_DIR'], llm_model='different-env')
with Session(create_engine(os.environ['DATABASE_URL'])) as db:
    settings = get_runtime_settings(db, base)
    assert settings.llm_api_key.get_secret_value() == 'env-fake-secret'
    print(json.dumps({'model': settings.llm_model, 'chunk_size': settings.chunk_size_tokens}))
"""
    environment = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "USERPROFILE", "TEMP", "TMP") if key in os.environ}
    environment.update(DATABASE_URL=TEST_URL, APP_ENV="test", RUNTIME_CONFIG_DIR=str(base.runtime_config_dir))

    def child():
        process = subprocess.run([sys.executable, "-c", code], env=environment, capture_output=True,
                                 text=True, encoding="utf-8", cwd=Path(__file__).resolve().parents[1])
        assert process.returncode == 0, process.stderr
        return json.loads(process.stdout)

    assert child()["model"] == "persisted-one"
    with sessions() as db:
        save_configuration(db, ConfigurationSave(revision=1, llm={"model": "persisted-two"},
                           processing={"chunk_size_tokens": 1200}), base)
        db.commit()
    assert child() == {"model": "persisted-two", "chunk_size": 1200}
    assert active.llm_model == "persisted-one"
    assert active.chunk_size_tokens == 800
