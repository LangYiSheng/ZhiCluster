"""Registry dispatch with stable imports for ingestion callers."""

from pathlib import Path

from app.ingestion.format_registry import get_format, get_registry
from app.ingestion.parser_types import ParsedDocument, ParsedSection, ParseError  # noqa: F401
from app.ingestion.text_helpers import decode_text  # noqa: F401


def validate_content(data: bytes, ext: str, max_uncompressed_bytes: int = 200 * 1024 * 1024) -> None:
    spec = get_format(ext)
    if not data:
        raise ParseError("文件为空")
    available, reason = spec.available()
    if not available:
        raise ParseError(reason)
    spec.validate(data, max_uncompressed_bytes)


def parse_document(path: str | Path, ext: str | None = None) -> ParsedDocument:
    file_path = Path(path)
    extension = (ext or file_path.suffix).lower().lstrip(".")
    data = file_path.read_bytes()
    validate_content(data, extension)
    try:
        parsed = get_format(extension).parse(data)
    except ImportError as error:
        raise ParseError("缺少文档解析依赖，请安装项目依赖或使用 Docker 运行") from error
    if not parsed.sections:
        raise ParseError("文档没有可提取的正文")
    return parsed


def __getattr__(name):
    if name == "SUPPORTED_EXTENSIONS":
        return get_registry().extensions
    raise AttributeError(name)
