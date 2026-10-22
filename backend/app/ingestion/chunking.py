"""Token-bounded chunks with deterministic overlap and source offsets."""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

import tiktoken

from app.ingestion.parsers import ParsedSection


@lru_cache(maxsize=1)
def tokenizer():
    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    return len(tokenizer().encode(text, disallowed_special=()))


@dataclass(frozen=True)
class ParsedChunk:
    section_index: int
    chunk_index: int
    content: str
    token_count: int
    anchor: dict[str, int]
    source_start: int
    source_end: int


def _bounded_end(text: str, start: int, token_limit: int) -> int:
    low, high = start + 1, len(text)
    best = start + 1
    while low <= high:
        midpoint = (low + high) // 2
        if count_tokens(text[start:midpoint]) <= token_limit:
            best, low = midpoint, midpoint + 1
        else:
            high = midpoint - 1
    return best


def split_text(text: str, size: int = 800, overlap: int = 100) -> list[tuple[int, int]]:
    if size < 8 or overlap < 0 or overlap >= size:
        raise ValueError("chunk size must be >= 8 and 0 <= overlap < size")
    ranges = []
    start = 0
    while start < len(text):
        end = _bounded_end(text, start, size)
        if end < len(text):
            boundaries = [match.end() for match in re.finditer(r"[。！？.!?]\s*|\n+", text[start:end])]
            useful = [point for point in boundaries if point > (end - start) // 2]
            if useful:
                end = start + useful[-1]
        ranges.append((start, end))
        if end >= len(text):
            break
        if overlap == 0:
            start = end
        else:
            low, high = start + 1, end
            suffix_start = end
            while low <= high:
                midpoint = (low + high) // 2
                if count_tokens(text[midpoint:end]) <= overlap:
                    suffix_start, high = midpoint, midpoint - 1
                else:
                    low = midpoint + 1
            start = max(start + 1, suffix_start)
    return ranges


def chunk_sections(sections: list[ParsedSection], size: int = 800, overlap: int = 100) -> list[ParsedChunk]:
    chunks = []
    for section_index, section in enumerate(sections):
        for start, end in split_text(section.text, size, overlap):
            content = section.text[start:end]
            if not content.strip():
                continue
            anchor = dict(section.anchor)
            if "line_start" in anchor:
                anchor["line_start"] = section.anchor["line_start"] + section.text[:start].count("\n")
                anchor["line_end"] = anchor["line_start"] + content.rstrip("\n").count("\n")
            chunks.append(ParsedChunk(section_index, len(chunks), content, count_tokens(content), anchor, section.source_start + start, section.source_start + end))
    return chunks
