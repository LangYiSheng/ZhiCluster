"""Small bounded helpers shared by structured document extractors."""

from __future__ import annotations

import io
import posixpath
import re
import zipfile
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

from app.ingestion.parser_types import ParsedDocument, ParsedSection, ParseError

MAX_TEXT_CHARS = 20_000_000
MAX_SECTIONS = 20_000
MAX_ARCHIVE_MEMBERS = 20_000
DEFAULT_ARCHIVE_LIMIT = 200 * 1024 * 1024


def checked_archive(data: bytes, label: str, required: set[str], limit: int = DEFAULT_ARCHIVE_LIMIT):
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        entries = archive.infolist()
        names = {entry.filename for entry in entries}
        if len(entries) > MAX_ARCHIVE_MEMBERS or sum(entry.file_size for entry in entries) > limit:
            raise ParseError(f"{label} 解压后的内容超过解析限制")
        if len(names) != len(entries):
            raise ParseError(f"{label} 包含重复压缩成员")
        if any(entry.flag_bits & 1 for entry in entries):
            raise ParseError(f"{label} 已加密，请先移除密码")
        if any("\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name)
               or ".." in name.split("/") or "." in name.split("/") for name in names):
            raise ParseError(f"{label} 包含非法压缩成员路径")
        if not required.issubset(names):
            raise ParseError(f"文件不是有效的 {label} 文档")
        if any("vbaproject" in name.casefold() for name in names):
            raise ParseError("不接收含宏的文档")
        for entry in entries:
            if entry.filename.lower().endswith((".xml", ".rels", ".opf")):
                tail = b""
                with archive.open(entry) as stream:
                    while block := stream.read(65536):
                        # XML may use UTF-16/32. Its ASCII declarations still
                        # need screening when code units contain NUL bytes.
                        text = (tail + block).replace(b"\x00", b"").upper()
                        if b"<!DOCTYPE" in text or b"<!ENTITY" in text:
                            raise ParseError(f"{label} 包含不支持的 XML 声明")
                        tail = text[-16:]
        return archive
    except (zipfile.BadZipFile, OSError, RuntimeError, NotImplementedError, EOFError) as error:
        if "archive" in locals():
            archive.close()
        raise ParseError(f"{label} 无法读取或文件已损坏") from error
    except Exception:
        if "archive" in locals():
            archive.close()
        raise


def safe_xml(data: bytes, label: str):
    declarations = data.replace(b"\x00", b"").upper()
    if b"<!DOCTYPE" in declarations or b"<!ENTITY" in declarations:
        raise ParseError(f"{label} 包含不支持的 XML 声明")
    try:
        return ElementTree.fromstring(data)
    except ElementTree.ParseError as error:
        raise ParseError(f"{label} 的 XML 结构已损坏") from error


def archive_path(base: str, href: str) -> str:
    """Resolve an EPUB member, allowing parent references only within the archive."""
    parsed = urlsplit(href)
    if parsed.scheme or parsed.netloc or not parsed.path or "\\" in parsed.path:
        raise ParseError("EPUB 包含非法或外部章节路径")
    decoded = unquote(parsed.path)
    if decoded.startswith("/") or "\\" in decoded or "\x00" in decoded:
        raise ParseError("EPUB 包含非法章节路径")
    result = posixpath.normpath(posixpath.join(base, decoded))
    if result == ".." or result.startswith("../") or PurePosixPath(result).is_absolute():
        raise ParseError("EPUB 章节路径超出文档范围")
    return result


class DocumentBuilder:
    def __init__(self, format_name: str):
        self.format_name = format_name
        self.sections: list[ParsedSection] = []
        self.pieces: list[str] = []
        self.offset = 0

    def add(self, heading: str, text: str, anchor: dict[str, int | str], level: int = 1, parent: int | None = None):
        body = text.strip()
        if not body:
            return
        if len(self.sections) >= MAX_SECTIONS or self.offset + len(body) > MAX_TEXT_CHARS:
            raise ParseError("提取的内容超过解析限制，请拆分文件后重试")
        self.sections.append(ParsedSection(heading[:500] or "正文", level, body, dict(anchor),
            self.offset, self.offset + len(body), parent))
        self.pieces.append(body)
        self.offset += len(body) + 2

    def build(self, **metadata) -> ParsedDocument:
        if not self.sections:
            raise ParseError("文档没有可提取的正文")
        return ParsedDocument(self.sections, "\n\n".join(self.pieces), {"format": self.format_name, **metadata})
