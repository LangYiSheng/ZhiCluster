"""Format-specific extractors; optional dependencies are imported only on use."""

from app.ingestion.formats.ebook import parse_epub, validate_epub
from app.ingestion.formats.office import parse_pptx, parse_xlsx, validate_pptx, validate_xlsx
from app.ingestion.formats.textual import (
    parse_csv,
    parse_html,
    parse_json,
    parse_jsonl,
    validate_csv,
    validate_html,
    validate_json,
    validate_jsonl,
)

__all__ = [
    "parse_csv", "parse_epub", "parse_html", "parse_json", "parse_jsonl", "parse_pptx", "parse_xlsx",
    "validate_csv", "validate_epub", "validate_html", "validate_json", "validate_jsonl", "validate_pptx", "validate_xlsx",
]
