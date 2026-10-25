"""Read EPUB spine content in publication order without external resource I/O."""

from __future__ import annotations

import posixpath

from app.ingestion.formats.common import (
    DEFAULT_ARCHIVE_LIMIT,
    DocumentBuilder,
    archive_path,
    checked_archive,
    safe_xml,
)
from app.ingestion.formats.textual import html_blocks
from app.ingestion.parser_types import ParseError


def _epub_package(archive):
    if archive.read("mimetype").strip() != b"application/epub+zip":
        raise ParseError("文件不是有效的 EPUB 文档")
    if "META-INF/encryption.xml" in archive.namelist() or "META-INF/rights.xml" in archive.namelist():
        raise ParseError("EPUB 包含加密或 DRM 内容，请先提供可读取的版本")
    container = safe_xml(archive.read("META-INF/container.xml"), "EPUB 容器")
    rootfile = container.find(".//{*}rootfile")
    if rootfile is None or not rootfile.get("full-path"):
        raise ParseError("EPUB 缺少内容清单")
    package_path = archive_path("", rootfile.get("full-path"))
    if package_path not in archive.namelist():
        raise ParseError("EPUB 内容清单不存在")
    package = safe_xml(archive.read(package_path), "EPUB 内容清单")
    manifest = {}
    for item in package.findall(".//{*}manifest/{*}item"):
        identifier = item.get("id")
        if identifier:
            manifest[identifier] = item
    chapters = []
    for itemref in package.findall(".//{*}spine/{*}itemref"):
        if itemref.get("linear", "yes") == "no":
            continue
        item = manifest.get(itemref.get("idref"))
        if item is None:
            raise ParseError("EPUB 阅读顺序引用了不存在的章节")
        if item.get("media-type") not in {"application/xhtml+xml", "text/html"}:
            continue
        href = archive_path(posixpath.dirname(package_path), item.get("href", ""))
        if href not in archive.namelist():
            raise ParseError("EPUB 章节文件不存在")
        chapters.append(href)
    if not chapters or len(chapters) > 10_000:
        raise ParseError("EPUB 没有可读取的正文或章节数量超过限制")
    return chapters


def validate_epub(data: bytes, max_uncompressed_bytes: int = DEFAULT_ARCHIVE_LIMIT):
    with checked_archive(data, "EPUB", {"mimetype", "META-INF/container.xml"}, max_uncompressed_bytes) as archive:
        try:
            _epub_package(archive)
        except (KeyError, RuntimeError, ValueError) as error:
            if isinstance(error, ParseError):
                raise
            raise ParseError("EPUB 无法读取或文件已损坏") from error


def parse_epub(data: bytes):
    builder = DocumentBuilder("epub")
    with checked_archive(data, "EPUB", {"mimetype", "META-INF/container.xml"}) as archive:
        try:
            chapters = _epub_package(archive)
            for index, member in enumerate(chapters, 1):
                blocks = html_blocks(archive.read(member))
                title = next((text for text, level in blocks if level), f"章节 {index}")
                builder.add(title, "\n\n".join(text for text, _ in blocks),
                    {"chapter_index": index, "chapter_path": member})
            return builder.build(chapters=len(chapters), preview="extracted_text", active_content="removed")
        except (KeyError, RuntimeError, ValueError) as error:
            if isinstance(error, ParseError):
                raise
            raise ParseError("EPUB 无法读取或文件已损坏") from error
