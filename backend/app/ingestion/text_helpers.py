"""Text decoding and source-preserving Markdown sections."""

import re

from charset_normalizer import from_bytes

from app.ingestion.parser_types import ParsedSection, ParseError
from app.ingestion.structure import FENCE


def decode_text(data: bytes) -> str:
    if b"\x00" in data and not data.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise ParseError("文本文件包含二进制内容")
    for encoding in ("utf-8-sig", "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "gb18030"):
        try:
            text = data.decode(encoding)
            if "\x00" not in text:
                return text.replace("\r\n", "\n").replace("\r", "\n")
        except UnicodeError:
            pass
    guess = from_bytes(data).best()
    if guess is None or guess.chaos > 0.3:
        raise ParseError("无法识别文本编码，请转换为 UTF-8 后重试")
    return str(guess).replace("\r\n", "\n").replace("\r", "\n")


def text_sections(text: str, markdown: bool) -> list[ParsedSection]:
    lines = text.splitlines(keepends=True)
    starts = []
    offset = 0
    fence = None
    for index, line in enumerate(lines):
        marker = FENCE.match(line.rstrip("\n")) if markdown else None
        inside_fence = bool(fence)
        if marker:
            if fence and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
            elif not fence:
                fence = marker[1]
        heading = re.match(r"^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$", line.rstrip("\n")) if markdown and not inside_fence and not marker else None
        if heading:
            starts.append((index, offset, heading.group(2), len(heading.group(1))))
        offset += len(line)
    if not starts or starts[0][0] > 0:
        starts.insert(0, (0, 0, "正文", 0))
    sections: list[ParsedSection] = []
    stack: list[tuple[int, int]] = []
    for position, (line_index, start, heading, level) in enumerate(starts):
        next_line = starts[position + 1][0] if position + 1 < len(starts) else len(lines)
        end = starts[position + 1][1] if position + 1 < len(starts) else len(text)
        body = text[start:end]
        if not body.strip():
            continue
        while stack and stack[-1][0] >= level:
            stack.pop()
        parent = stack[-1][1] if stack else None
        section = ParsedSection(heading, level, body, {"line_start": line_index + 1, "line_end": next_line}, start, end, parent)
        stack.append((level, len(sections)))
        sections.append(section)
    return sections
