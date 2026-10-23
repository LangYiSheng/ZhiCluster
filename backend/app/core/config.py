from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")
    app_env: str = "local"
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    database_url: str = "postgresql+psycopg://zhicluster:local_password@localhost:5432/zhicluster"
    upload_root: Path = Path("../.data/uploads")
    runtime_config_dir: Path = Path("../.data/runtime")
    max_upload_size_mb: int = 50
    max_upload_batch_mb: int = 200
    max_upload_batch_files: int = 20
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5173", "http://127.0.0.1:5173"]
    llm_base_url: str = ""
    llm_api_key: SecretStr = SecretStr("")
    llm_model: str = ""
    llm_timeout_seconds: float = 120
    llm_max_retries: int = 2
    llm_supports_tools: bool = False
    embedding_base_url: str = ""
    embedding_api_key: SecretStr = SecretStr("")
    embedding_model: str = ""
    embedding_dimension: int = 1024
    embedding_batch_size: int = 32
    embedding_timeout_seconds: float = 60
    embedding_max_retries: int = 2
    chunk_size_tokens: int = 800
    chunk_overlap_tokens: int = 100
    max_ingestion_attempts: int = 3
    max_concurrent_model_calls: int = 3
    job_lease_seconds: int = 180
    worker_poll_seconds: float = 2
    worker_ingestion_concurrency: int = 3
    worker_interactive_concurrency: int = 1
    summary_input_tokens: int = 6000
    summary_max_calls: int = 80

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_base_url and self.llm_api_key.get_secret_value() and self.llm_model)

    @property
    def embedding_configured(self) -> bool:
        return bool(self.embedding_base_url and self.embedding_api_key.get_secret_value() and self.embedding_model)


@lru_cache
def get_settings() -> Settings:
    return Settings()
