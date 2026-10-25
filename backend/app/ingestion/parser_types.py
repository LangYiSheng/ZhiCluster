"""Shared parser results and honest source anchors for format adapters."""

from dataclasses import dataclass, field


class ParseError(ValueError):
    """A user-correctable file format or document content error."""


@dataclass(frozen=True)
class ParsedSection:
    heading: str
    level: int
    text: str
    anchor: dict[str, int | str]
    source_start: int
    source_end: int
    parent_index: int | None = None


@dataclass(frozen=True)
class ParsedDocument:
    sections: list[ParsedSection]
    plain_text: str
    metadata: dict = field(default_factory=dict)
