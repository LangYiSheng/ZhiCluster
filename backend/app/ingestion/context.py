"""Bounded metadata context for embeddings; source chunks remain unchanged."""

import re
from dataclasses import dataclass

from app.ingestion.chunking import split_text
from app.ingestion.structure import TABLE_RULE, source_blocks


@dataclass(frozen=True)
class SectionContext:
    heading: str
    parent: str | None
    text: str
    source_start: int
    tables: tuple


class ChunkContext:
    """Snapshot ORM metadata before provider calls; no session or writes inside."""

    def __init__(self, document_name: str, sections, context_tokens: int = 96):
        self.document_name = document_name[:160]
        self.context_tokens = max(8, context_tokens)
        self.sections = {}
        for section in sections:
            text = section.plain_text
            self.sections[section.id] = SectionContext(
                section.heading, section.parent_section_id, text,
                section.anchors.get("source_start", 0),
                tuple(block for block in source_blocks(text) if block.kind == "table"),
            )

    def text(self, chunk) -> str:
        section = self.sections.get(chunk.section_id)
        headings, visited = [], set()
        current = section
        while current and id(current) not in visited and len(visited) < 16:
            visited.add(id(current))
            heading = current.heading.strip()
            if heading and heading != "正文" and not re.fullmatch(r"第\s*\d+\s*页", heading):
                headings.append(heading[:120])
            current = self.sections.get(current.parent)
        labels = [f"文档：{self.document_name}"]
        if headings:
            labels.append("章节：" + " / ".join(reversed(headings)))
        if section:
            relative_start = chunk.source_start - section.source_start
            for table in section.tables:
                if table.start < relative_start < table.end:
                    header_end = table.rows[0][1]
                    if len(table.rows) > 1 and TABLE_RULE.match(section.text[slice(*table.rows[1])].strip()):
                        header_end = table.rows[1][1]
                    header = section.text[table.start:header_end].strip()
                    if header and header not in chunk.content:
                        labels.append("表头：" + header)
                    break
        context = "\n".join(labels)
        start, end = split_text(context, size=self.context_tokens, overlap=0)[0]
        return context[start:end] + "\n\n" + chunk.content
