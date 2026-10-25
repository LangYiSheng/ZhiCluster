"""One format registry drives validation, parsing, MIME handling and UI capabilities."""

from dataclasses import dataclass, field
from functools import lru_cache
from importlib.util import find_spec
from typing import Callable, Literal

from app.ingestion.parser_types import ParsedDocument, ParseError


@dataclass(frozen=True)
class FormatSpec:
    extension: str
    label: str
    mime_type: str
    validate: Callable[[bytes, int], None]
    parse: Callable[[bytes], ParsedDocument]
    accepted_mimes: tuple[str, ...] = ()
    preview: Literal["pdf", "text"] = "text"
    dependencies: tuple[str, ...] = ()
    availability: Callable[[], tuple[bool, str | None]] | None = field(default=None, repr=False)

    def available(self):
        missing = [dependency for dependency in self.dependencies if find_spec(dependency) is None]
        if missing:
            return False, f"缺少解析依赖：{', '.join(missing)}；请安装项目依赖或使用 Docker 运行"
        return self.availability() if self.availability else (True, None)

    def public(self):
        available, reason = self.available()
        return {"extension": self.extension, "label": self.label, "mime_type": self.mime_type,
            "preview": self.preview, "available": available, **({"reason": reason} if reason else {})}


class FormatRegistry:
    def __init__(self):
        self._formats: dict[str, FormatSpec] = {}

    def register(self, spec: FormatSpec):
        extension = spec.extension.lower().lstrip(".")
        if extension != spec.extension or extension in self._formats:
            raise ValueError(f"Invalid or duplicate format registration: {spec.extension}")
        self._formats[extension] = spec
        return spec

    def get(self, extension: str):
        spec = self._formats.get(extension.lower().lstrip("."))
        if spec is None:
            raise ParseError("不支持此文件格式，请查看上传入口列出的支持格式")
        return spec

    def values(self):
        return tuple(self._formats.values())

    @property
    def extensions(self):
        return frozenset(self._formats)


def _validate_text(data, max_uncompressed_bytes):
    from app.ingestion.text_helpers import decode_text

    decode_text(data)


def _parse_text(data, *, markdown=False):
    from app.ingestion.text_helpers import decode_text, text_sections

    text = decode_text(data)
    return ParsedDocument(text_sections(text, markdown), text,
        {"format": "md" if markdown else "txt", "lines": len(text.splitlines())})


@lru_cache(maxsize=1)
def get_registry():
    from app.ingestion import core_formats, formats, legacy_formats

    registry = FormatRegistry()
    registry.register(FormatSpec("pdf", "PDF", "application/pdf", core_formats.validate_pdf, core_formats.parse_pdf,
        preview="pdf", dependencies=("pymupdf",)))
    registry.register(FormatSpec("docx", "Word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        core_formats.validate_docx, core_formats.parse_docx, ("application/zip",), dependencies=("docx",)))
    registry.register(FormatSpec("md", "Markdown", "text/markdown", _validate_text,
        lambda data: _parse_text(data, markdown=True), ("text/plain", "text/x-markdown")))
    registry.register(FormatSpec("txt", "纯文本", "text/plain", _validate_text, _parse_text))
    registry.register(FormatSpec("pptx", "PowerPoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        formats.validate_pptx, formats.parse_pptx, ("application/zip",), dependencies=("pptx",)))
    registry.register(FormatSpec("xlsx", "Excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        formats.validate_xlsx, formats.parse_xlsx, ("application/zip",), dependencies=("openpyxl",)))
    registry.register(FormatSpec("csv", "CSV", "text/csv", formats.validate_csv, formats.parse_csv,
        ("text/plain", "application/csv", "application/vnd.ms-excel")))
    for extension in ("html", "htm"):
        registry.register(FormatSpec(extension, "HTML", "text/html", formats.validate_html,
            lambda data, ext=extension: formats.parse_html(data, ext=ext), ("application/xhtml+xml", "text/plain"),
            dependencies=("bs4",)))
    registry.register(FormatSpec("json", "JSON", "application/json", formats.validate_json, formats.parse_json,
        ("text/json", "text/plain")))
    registry.register(FormatSpec("jsonl", "JSON Lines", "application/x-ndjson", formats.validate_jsonl, formats.parse_jsonl,
        ("application/jsonl", "application/json", "text/plain")))
    registry.register(FormatSpec("doc", "Word 旧版", "application/msword", legacy_formats.validate_doc, legacy_formats.parse_doc,
        ("application/x-ole-storage",), dependencies=("olefile",), availability=legacy_formats.office_availability))
    registry.register(FormatSpec("xls", "Excel 旧版", "application/vnd.ms-excel", legacy_formats.validate_xls, legacy_formats.parse_xls,
        ("application/x-ole-storage",), dependencies=("xlrd", "olefile")))
    registry.register(FormatSpec("ppt", "PowerPoint 旧版", "application/vnd.ms-powerpoint", legacy_formats.validate_ppt, legacy_formats.parse_ppt,
        ("application/x-ole-storage",), dependencies=("olefile",), availability=legacy_formats.office_availability))
    registry.register(FormatSpec("epub", "EPUB", "application/epub+zip", formats.validate_epub, formats.parse_epub,
        ("application/zip",), dependencies=("bs4",)))
    return registry


def get_format(extension):
    return get_registry().get(extension)
