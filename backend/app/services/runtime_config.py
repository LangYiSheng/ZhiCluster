"""Database-backed configuration snapshots, shared by independent API/workers.

Only this module decrypts database credentials. No plaintext credentials enter
the public representation, revision metadata, task payloads, or error messages.
"""

import copy
import os
from pathlib import Path
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken
from pydantic import SecretStr
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.db.models import AppConfiguration, utcnow
from app.schemas.settings import ConfigurationDraft, ConfigurationSave

CONFIG_ID = "runtime"
PROVIDER_FIELDS = ("base_url", "model", "timeout_seconds", "max_retries")
PROCESSING_FIELDS = (
    "chunk_size_tokens", "chunk_overlap_tokens", "max_ingestion_attempts",
    "max_concurrent_model_calls", "summary_input_tokens", "summary_max_calls",
)


def _cipher(directory: Path, *, create: bool) -> Fernet:
    path = Path(directory) / "master.key"
    try:
        if not path.exists() and create:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            # Write an O_EXCL private candidate first. Atomic hard-link publication
            # exposes a complete key and never replaces another process's key.
            candidate = path.parent / f".master-{uuid4().hex}.tmp"
            try:
                fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(Fernet.generate_key())
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(candidate, path)
                except FileExistsError:
                    pass
                if os.name != "nt":
                    directory_fd = os.open(path.parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
            finally:
                candidate.unlink(missing_ok=True)
        # A missing key with existing ciphertext must fail closed. Never generate
        # a replacement key or silently fall back to the environment in that case.
        key = path.read_bytes()
        if os.name != "nt":
            os.chmod(path, 0o600)
        return Fernet(key)
    except (OSError, ValueError) as error:
        raise AppError("configuration_key_unavailable", "运行配置密钥不可用，请恢复私有 runtime 卷中的 master.key", 503) from error


def _row(db):
    return db.scalar(select(AppConfiguration).where(AppConfiguration.id == CONFIG_ID)
                     .execution_options(populate_existing=True))


def _snapshot(base, row):
    if not row:
        return copy.deepcopy(base)
    values = dict(row.values)
    encrypted = row.secrets
    if encrypted:
        cipher = _cipher(base.runtime_config_dir, create=False)
        try:
            values.update({field: SecretStr(cipher.decrypt(token.encode()).decode())
                           for field, token in encrypted.items()})
        except (InvalidToken, ValueError, UnicodeError, TypeError, AttributeError) as error:
            raise AppError("configuration_decryption_failed", "运行配置无法解密，请检查是否挂载了正确的私有 runtime 卷", 503) from error
    return base.model_copy(update=values, deep=True)


def get_runtime_settings(db, base: Settings | None = None):
    """Read one uncached snapshot; the caller owns its lifetime."""
    return _snapshot(base or get_settings(), _row(db))


def public_configuration(settings, revision: int):
    result = {"revision": revision}
    for prefix in ("llm", "embedding"):
        fields = (*PROVIDER_FIELDS, "supports_tools") if prefix == "llm" else (*PROVIDER_FIELDS, "dimension", "batch_size")
        result[prefix] = {field: getattr(settings, f"{prefix}_{field}") for field in fields}
        result[prefix]["api_key_configured"] = bool(getattr(settings, f"{prefix}_api_key").get_secret_value())
    result["processing"] = {field: getattr(settings, field) for field in PROCESSING_FIELDS}
    return result


def read_configuration(db, base=None):
    base = base or get_settings()
    row = _row(db)
    return public_configuration(_snapshot(base, row), row.revision if row else 0)


def apply_draft(settings, draft: ConfigurationDraft | None):
    if draft is None:
        return settings
    updates = {}
    for prefix in ("llm", "embedding"):
        patch = getattr(draft, prefix)
        if patch is None:
            continue
        for field, value in patch.model_dump(exclude_none=True, exclude={"api_key", "clear_api_key"}).items():
            updates[f"{prefix}_{field}"] = value
        if patch.clear_api_key:
            updates[f"{prefix}_api_key"] = SecretStr("")
        elif patch.api_key and patch.api_key.get_secret_value():
            updates[f"{prefix}_api_key"] = patch.api_key
    if draft.processing:
        updates.update(draft.processing.model_dump(exclude_none=True))
    result = settings.model_copy(update=updates, deep=True)
    if result.chunk_overlap_tokens >= result.chunk_size_tokens:
        raise AppError("invalid_configuration", "分块重叠 Token 数必须小于分块大小", 422)
    return result


def save_configuration(db, body: ConfigurationSave, base=None):
    base = base or get_settings()
    row = _row(db)
    revision = row.revision if row else 0
    if body.revision != revision:
        raise AppError("configuration_conflict", "配置已被其他页面修改，请重新载入后再保存", 409)
    settings = apply_draft(_snapshot(base, row), body)
    public = public_configuration(settings, revision + 1)
    values = {}
    for prefix in ("llm", "embedding"):
        values.update({f"{prefix}_{field}": value for field, value in public[prefix].items()
                       if field != "api_key_configured"})
    values.update(public["processing"])
    cipher = _cipher(base.runtime_config_dir, create=not bool(row and row.secrets))
    secrets = {f"{prefix}_api_key": cipher.encrypt(getattr(settings, f"{prefix}_api_key").get_secret_value().encode()).decode()
               for prefix in ("llm", "embedding")}
    if row:
        changed = db.execute(update(AppConfiguration).where(AppConfiguration.id == CONFIG_ID,
                             AppConfiguration.revision == revision).values(revision=revision + 1,
                             values=values, secrets=secrets, updated_at=utcnow()).execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            raise AppError("configuration_conflict", "配置已被其他页面修改，请重新载入后再保存", 409)
    else:
        db.add(AppConfiguration(id=CONFIG_ID, revision=1, values=values, secrets=secrets))
        try:
            db.flush()
        except IntegrityError as error:
            raise AppError("configuration_conflict", "配置已被其他页面修改，请重新载入后再保存", 409) from error
    return public
