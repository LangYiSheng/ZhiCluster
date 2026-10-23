"""Writable runtime fields only; infrastructure remains environment-controlled."""

from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator


class RuntimeInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ProviderPatch(RuntimeInput):
    base_url: str | None = Field(None, max_length=2048)
    model: str | None = Field(None, max_length=512)
    api_key: SecretStr | None = Field(None, max_length=4096, repr=False)
    clear_api_key: bool = False
    timeout_seconds: float | None = Field(None, ge=1, le=600, allow_inf_nan=False)
    max_retries: int | None = Field(None, ge=0, le=4)

    @field_validator("base_url")
    @classmethod
    def valid_url(cls, value):
        if value is None:
            return value
        value = value.strip().rstrip("/")
        if not value:
            return value
        try:
            parsed = urlsplit(value)
            valid = (parsed.scheme in {"http", "https"} and parsed.hostname
                     and parsed.username is None and parsed.password is None
                     and not parsed.query and not parsed.fragment and "?" not in value and "#" not in value
                     and not any(char.isspace() or ord(char) < 32 for char in value))
            _ = parsed.port
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("服务地址必须为不含凭证、查询参数和片段的 HTTP/HTTPS URL")
        return value

    @field_validator("model")
    @classmethod
    def valid_model(cls, value):
        if value is not None:
            value = value.strip()
            if any(ord(char) < 32 for char in value):
                raise ValueError("模型名称不能包含控制字符")
        return value

    @field_validator("api_key")
    @classmethod
    def valid_key(cls, value):
        if value is not None:
            raw = value.get_secret_value().strip()
            if any(char.isspace() or ord(char) < 32 for char in raw):
                raise ValueError("密钥不能包含空白或控制字符")
            return SecretStr(raw)
        return value

    @model_validator(mode="after")
    def key_action(self):
        if self.clear_api_key and self.api_key and self.api_key.get_secret_value():
            raise ValueError("替换密钥和清除密钥不能同时选择")
        return self


class LlmPatch(ProviderPatch):
    supports_tools: bool | None = None


class EmbeddingPatch(ProviderPatch):
    dimension: int | None = Field(None, ge=1, le=16000)
    batch_size: int | None = Field(None, ge=1, le=256)


class ProcessingPatch(RuntimeInput):
    chunk_size_tokens: int | None = Field(None, ge=128, le=8192)
    chunk_overlap_tokens: int | None = Field(None, ge=0, le=2048)
    max_ingestion_attempts: int | None = Field(None, ge=1, le=10)
    max_concurrent_model_calls: int | None = Field(None, ge=1, le=16)
    summary_input_tokens: int | None = Field(None, ge=1024, le=200000)
    summary_max_calls: int | None = Field(None, ge=1, le=100)


class ConfigurationDraft(RuntimeInput):
    llm: LlmPatch | None = None
    embedding: EmbeddingPatch | None = None
    processing: ProcessingPatch | None = None


class ConfigurationSave(ConfigurationDraft):
    revision: int = Field(ge=0)


class ModelTestRequest(RuntimeInput):
    scope: Literal["llm", "embedding", "tool_calling"] | None = None
    draft: ConfigurationDraft | None = None


class ModelListRequest(RuntimeInput):
    scope: Literal["llm", "embedding"]
    draft: ConfigurationDraft | None = None
