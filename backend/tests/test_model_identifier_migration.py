"""SQLite migration preserves existing model identifiers and profile references."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_sqlite_model_identifier_migration_preserves_rows_and_references(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'model-identifiers.db'}")
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE embedding_profiles (id varchar(36) PRIMARY KEY, model_name varchar(200) NOT NULL, fingerprint varchar(64) NOT NULL UNIQUE)"))
            connection.execute(text("CREATE TABLE classification_suggestions (id varchar(36) PRIMARY KEY, model varchar(200) NOT NULL)"))
            connection.execute(text("CREATE TABLE chunk_embeddings (id varchar(36) PRIMARY KEY, profile_id varchar(36) REFERENCES embedding_profiles(id))"))
            connection.execute(text("INSERT INTO embedding_profiles VALUES ('profile', 'vendor/embedding-v1.2:latest', 'fingerprint')"))
            connection.execute(text("INSERT INTO classification_suggestions VALUES ('suggestion', 'vendor/chat-v1.2:latest')"))
            connection.execute(text("INSERT INTO chunk_embeddings VALUES ('chunk', 'profile')"))
            path = Path(__file__).parents[1] / "alembic/versions/07_model_identifiers.py"
            spec = spec_from_file_location("model_identifiers_sqlite_test", path)
            migration = module_from_spec(spec)
            spec.loader.exec_module(migration)
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
            for table, column in (("embedding_profiles", "model_name"), ("classification_suggestions", "model")):
                actual = next(item for item in inspect(connection).get_columns(table) if item["name"] == column)
                assert actual["type"].length == 512
            assert connection.scalar(text("SELECT model_name FROM embedding_profiles")) == "vendor/embedding-v1.2:latest"
            assert connection.scalar(text("SELECT model FROM classification_suggestions")) == "vendor/chat-v1.2:latest"
            assert connection.scalar(text("SELECT profile_id FROM chunk_embeddings")) == "profile"
            assert inspect(connection).get_foreign_keys("chunk_embeddings")[0]["referred_table"] == "embedding_profiles"
            migration.downgrade()
            for table, column in (("embedding_profiles", "model_name"), ("classification_suggestions", "model")):
                actual = next(item for item in inspect(connection).get_columns(table) if item["name"] == column)
                assert actual["type"].length == 200
    finally:
        engine.dispose()
