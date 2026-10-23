"""Lightweight source spans shared by chunking and contextual embedding."""

import re
from dataclasses import dataclass

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$")


@dataclass(frozen=True)
class SourceBlock:
    start: int
    end: int
    kind: str
    rows: tuple[tuple[int, int], ...] = ()


def source_blocks(text: str) -> list[SourceBlock]:
    """Recognize fenced code and pipe tables without modifying source bytes."""
    blocks = []
    offset = 0
    fence = None
    table = []

    def finish_table():
        if len(table) >= 2:
            blocks.append(SourceBlock(table[0][0], table[-1][1], "table", tuple(table)))
        table.clear()

    for line in text.splitlines(keepends=True):
        end = offset + len(line)
        marker = FENCE.match(line.rstrip("\n"))
        if fence:
            opening, start = fence
            if marker and marker[1][0] == opening[0] and len(marker[1]) >= len(opening) and not marker[2].strip():
                blocks.append(SourceBlock(start, end, "code"))
                fence = None
        elif marker:
            finish_table()
            fence = (marker[1], offset)
        elif "|" in line and len(line.strip().strip("|").split("|")) >= 2:
            table.append((offset, end))
        else:
            finish_table()
        offset = end
    finish_table()
    if fence:
        blocks.append(SourceBlock(fence[1], len(text), "code"))
    return sorted(blocks, key=lambda block: block.start)
