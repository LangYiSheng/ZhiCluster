"""Extract tabular, web and JSON text with honest record/source coordinates."""

from __future__ import annotations

import csv
import io
import json
import re

from app.ingestion.formats.common import DEFAULT_ARCHIVE_LIMIT, MAX_TEXT_CHARS, DocumentBuilder
from app.ingestion.parser_types import ParseError
from app.ingestion.text_helpers import decode_text

MAX_RECORDS = 100_000
MAX_FIELDS = 1_024
MAX_HTML_BYTES = 20 * 1024 * 1024


def _bounded_text(data: bytes):
    if not data:
        raise ParseError("文件为空")
    text = decode_text(data)
    if len(text) > MAX_TEXT_CHARS:
        raise ParseError("文本内容超过解析限制，请拆分文件")
    return text


def _csv_reader(data: bytes):
    text = _bounded_text(data)
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",\t;|")
    except csv.Error:
        dialect = csv.excel
    # The default 128 KiB cell cap is deliberate: a CSV row is a readable
    # record, not an unbounded binary/text container hidden in one cell.
    return csv.reader(io.StringIO(text, newline=""), dialect=dialect, strict=True)


def validate_csv(data: bytes, max_uncompressed_bytes: int = DEFAULT_ARCHIVE_LIMIT):
    del max_uncompressed_bytes
    try:
        reader = _csv_reader(data)
        for index, row in enumerate(reader, 1):
            if index > MAX_RECORDS or len(row) > MAX_FIELDS:
                raise ParseError("CSV 行数或列数超过解析限制，请拆分文件")
    except csv.Error as error:
        raise ParseError("CSV 结构无法读取，请检查引号、分隔符和单元格长度") from error


def parse_csv(data: bytes):
    builder = DocumentBuilder("csv")
    rows = []
    start = 1
    last = 0
    count = 0
    try:
        for index, row in enumerate(_csv_reader(data), 1):
            if index > MAX_RECORDS or len(row) > MAX_FIELDS:
                raise ParseError("CSV 行数或列数超过解析限制，请拆分文件")
            count = index
            if not any(cell.strip() for cell in row):
                continue
            if not rows:
                start = index
            rows.append(f"行 {index}: " + " | ".join(row))
            last = index
            if len(rows) == 100:
                builder.add(f"CSV · 行 {start}–{last}", "\n".join(rows), {"row_start": start, "row_end": last})
                rows = []
        if rows:
            builder.add(f"CSV · 行 {start}–{last}", "\n".join(rows), {"row_start": start, "row_end": last})
        return builder.build(rows=count, preview="extracted_text")
    except csv.Error as error:
        raise ParseError("CSV 结构无法读取，请检查引号、分隔符和单元格长度") from error


def validate_html(data: bytes, max_uncompressed_bytes: int = DEFAULT_ARCHIVE_LIMIT):
    if len(data) > min(max_uncompressed_bytes, MAX_HTML_BYTES):
        raise ParseError("HTML 内容超过解析限制，请拆分文件")
    _bounded_text(data)


def html_blocks(data: bytes):
    """Return visible text blocks; neither HTML nor linked resources execute."""
    try:
        from bs4 import BeautifulSoup, Comment, NavigableString, Tag
    except ImportError as error:
        raise ParseError("HTML/EPUB 解析依赖未安装，请安装 beautifulsoup4") from error
    validate_html(data)
    soup = BeautifulSoup(decode_text(data), "html.parser")
    for element in list(soup.find_all(["script", "style", "template", "noscript", "iframe", "object", "svg", "head"])):
        element.decompose()
    for element in list(soup.find_all(attrs={"hidden": True})) + list(soup.find_all(attrs={"aria-hidden": "true"})):
        if element.parent is not None:
            element.decompose()
    for element in list(soup.find_all(style=True)):
        if element.parent is not None and re.search(r"(?:display\s*:\s*none|visibility\s*:\s*hidden)", element.get("style", ""), re.I):
            element.decompose()
    for comment in soup.find_all(string=lambda node: isinstance(node, Comment)):
        comment.extract()
    blocks: list[tuple[str, int]] = []
    inline: list[str] = []
    block_tags = {"p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "li", "blockquote", "pre", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}

    def flush():
        text = " ".join(part.strip() for part in inline if part.strip()).strip()
        inline.clear()
        if text:
            blocks.append((text, 0))

    def visit(node):
        if isinstance(node, NavigableString):
            inline.append(str(node))
            return
        if not isinstance(node, Tag):
            return
        if node.name in {"br", "hr"}:
            flush()
            return
        if re.fullmatch(r"h[1-6]", node.name or ""):
            flush()
            text = node.get_text(" ", strip=True)
            if text:
                blocks.append((text, int(node.name[1])))
            return
        if node.name in {"pre", "tr"}:
            flush()
            if node.name == "tr":
                text = " | ".join(cell.get_text(" ", strip=True) for cell in node.find_all(["td", "th"], recursive=False))
            else:
                text = node.get_text("", strip=False)
            if text.strip():
                blocks.append((text.strip(), 0))
            return
        if node.name in block_tags:
            flush()
        for child in node.children:
            visit(child)
        if node.name in block_tags:
            flush()

    try:
        visit(soup.body or soup)
        flush()
    except RecursionError as error:
        raise ParseError("HTML 嵌套层级过深，请简化文档") from error
    return blocks


def parse_html(data: bytes, ext: str = "html"):
    builder = DocumentBuilder(ext)
    pending = []
    heading = "正文"
    level = 0
    paragraph_start = 1
    paragraph_index = 0
    stack: list[tuple[int, int]] = []

    def emit():
        nonlocal pending
        if not pending:
            return
        while stack and stack[-1][0] >= level:
            stack.pop()
        parent = stack[-1][1] if stack else None
        builder.add(heading, "\n\n".join(pending),
            {"paragraph_start": paragraph_start, "paragraph_end": paragraph_index}, level, parent)
        if level:
            stack.append((level, len(builder.sections) - 1))
        pending = []

    for text, heading_level in html_blocks(data):
        if heading_level:
            emit()
            heading, level = text, heading_level
            paragraph_start = paragraph_index + 1
        if not pending:
            paragraph_start = paragraph_index + 1
        pending.append(text)
        paragraph_index += 1
    emit()
    return builder.build(paragraphs=paragraph_index, preview="extracted_text", active_content="removed")


def _reject_constant(value):
    raise ValueError(f"invalid JSON constant {value}")


def _json_value(text: str):
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError) as error:
        raise ParseError("JSON 无法解析，请检查结构、嵌套深度和数值格式") from error


def validate_json(data: bytes, max_uncompressed_bytes: int = DEFAULT_ARCHIVE_LIMIT):
    del max_uncompressed_bytes
    value = _json_value(_bounded_text(data))
    if isinstance(value, list) and len(value) > MAX_RECORDS:
        raise ParseError("JSON 记录数量超过解析限制，请拆分文件")


def parse_json(data: bytes):
    value = _json_value(_bounded_text(data))
    builder = DocumentBuilder("json")
    try:
        if isinstance(value, list) and value:
            if len(value) > MAX_RECORDS:
                raise ParseError("JSON 记录数量超过解析限制，请拆分文件")
            for start in range(0, len(value), 100):
                end = min(start + 100, len(value))
                body = "\n\n".join(f"记录 {index + 1}:\n" + json.dumps(item, ensure_ascii=False, indent=2, allow_nan=False)
                    for index, item in enumerate(value[start:end], start))
                builder.add(f"记录 {start + 1}–{end}", body, {"record_start": start + 1, "record_end": end})
        else:
            builder.add("JSON", json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), {"record_start": 1, "record_end": 1})
        return builder.build(records=len(value) if isinstance(value, list) else 1, preview="extracted_text")
    except (ValueError, RecursionError) as error:
        if isinstance(error, ParseError):
            raise
        raise ParseError("JSON 无法展开，请减少嵌套层级") from error


def validate_jsonl(data: bytes, max_uncompressed_bytes: int = DEFAULT_ARCHIVE_LIMIT):
    del max_uncompressed_bytes
    records = 0
    for line_index, line in enumerate(_bounded_text(data).splitlines(), 1):
        if line.strip():
            try:
                _json_value(line)
            except ParseError as error:
                raise ParseError(f"JSONL 第 {line_index} 行不是有效 JSON") from error
            records += 1
            if records > MAX_RECORDS:
                raise ParseError("JSONL 记录数量超过解析限制，请拆分文件")


def parse_jsonl(data: bytes):
    builder = DocumentBuilder("jsonl")
    pending = []
    records = 0
    start_record = 1
    start_line = 1
    last_line = 0
    for line_index, line in enumerate(_bounded_text(data).splitlines(), 1):
        if not line.strip():
            if pending:
                pending.append("")
            continue
        try:
            value = _json_value(line)
            normalized = json.dumps(value, ensure_ascii=False, allow_nan=False)
        except (ParseError, ValueError, RecursionError) as error:
            raise ParseError(f"JSONL 第 {line_index} 行不是有效 JSON") from error
        records += 1
        if records > MAX_RECORDS:
            raise ParseError("JSONL 记录数量超过解析限制，请拆分文件")
        if not pending:
            start_line, start_record = line_index, records
        pending.append(normalized)
        last_line = line_index
        if records % 100 == 0:
            builder.add(f"JSONL · 记录 {start_record}–{records}", "\n".join(pending),
                {"line_start": start_line, "line_end": last_line, "record_start": start_record, "record_end": records})
            pending = []
    if pending:
        builder.add(f"JSONL · 记录 {start_record}–{records}", "\n".join(pending),
            {"line_start": start_line, "line_end": last_line, "record_start": start_record, "record_end": records})
    return builder.build(records=records, preview="extracted_text")
