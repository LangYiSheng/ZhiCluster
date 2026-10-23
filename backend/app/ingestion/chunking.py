"""Token-bounded chunks with deterministic overlap and source offsets."""

from __future__ import annotations

import re
from array import array
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from functools import lru_cache

import tiktoken

from app.ingestion.parsers import ParsedSection
from app.ingestion.structure import source_blocks


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


def _bounded_end(text: str, start: int, token_limit: int, stop: int) -> int:
    low, high = start + 1, stop
    best = start + 1
    while low <= high:
        midpoint = (low + high) // 2
        if count_tokens(text[start:midpoint]) <= token_limit:
            best, low = midpoint, midpoint + 1
        else:
            high = midpoint - 1
    return best


def _token_offsets(text: str):
    """Bound tokenizer allocations for long TXT files; offsets use four bytes."""
    encoding = tokenizer()
    offsets = array("I")
    total = 0
    for start in range(0, len(text), 32768):
        part = text[start:start + 32768]
        tokens = encoding.encode(part, disallowed_special=())
        total += len(tokens)
        decoded, local = encoding.decode_with_offsets(tokens)
        if decoded != part:
            local = range(len(part))
        offsets.extend(start + value for value in local)
    offsets.append(len(text))
    return offsets, total


def split_text(text: str, size: int = 800, overlap: int = 100) -> list[tuple[int, int]]:
    if size < 8 or overlap < 0 or overlap >= size:
        raise ValueError("chunk size must be >= 8 and 0 <= overlap < size")
    offsets, total = _token_offsets(text)
    if total <= size:
        return [(0, len(text))] if text else []
    protected = []
    for block in source_blocks(text):
        if block.end - block.start <= size * 32 and count_tokens(text[block.start:block.end]) <= size:
            protected.append((block.start, block.end))
        elif block.kind == "table":
            protected.extend((start, end) for start, end in block.rows if end - start <= size * 32 and count_tokens(text[start:end]) <= size)
    protected_starts = [span[0] for span in protected]

    def containing(position):
        index = bisect_right(protected_starts, position) - 1
        if index >= 0 and protected[index][0] < position < protected[index][1]:
            return protected[index]
        return None

    paragraphs = [match.end() for match in re.finditer(r"\n[ \t]*\n+", text) if not containing(match.end())]
    sentences = [match.end() for match in re.finditer(r"[。！？][”’」』]?\s*|[.!?][\"']?(?=\s|$)\s*|\n", text) if not containing(match.end())]
    ranges = []
    start = 0
    while start < len(text):
        token_start = bisect_left(offsets, start)
        end = offsets[min(token_start + size, len(offsets) - 1)]
        end = max(start + 1, end)
        # Cutting a BPE stream at a character boundary can change the first and
        # last token. Validate only this small window, never the whole remainder.
        if count_tokens(text[start:end]) > size:
            end = _bounded_end(text, start, size, end)
        atomic = containing(end)
        if atomic and atomic[0] > start:
            end = atomic[0]
        elif atomic and count_tokens(text[start:atomic[1]]) <= size:
            end = atomic[1]
        if end < len(text):
            floor = start + (end - start) // 2
            for boundaries in (paragraphs, sentences):
                index = bisect_right(boundaries, end) - 1
                if index >= 0 and boundaries[index] > floor:
                    end = boundaries[index]
                    break
        ranges.append((start, end))
        if end >= len(text):
            break
        if overlap == 0:
            start = end
        else:
            token_end = bisect_left(offsets, end)
            suffix_start = max(start + 1, offsets[max(0, token_end - overlap)])
            while suffix_start < end and count_tokens(text[suffix_start:end]) > overlap:
                suffix_start += 1
            atomic = containing(suffix_start)
            if atomic:
                # Do not start a second chunk halfway through a complete code
                # block/table/row just to manufacture overlap.
                suffix_start = atomic[0] if atomic[0] > start and count_tokens(text[atomic[0]:end]) <= overlap else end
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
