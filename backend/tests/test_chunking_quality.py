from types import SimpleNamespace

import pytest

from app.ingestion.chunking import chunk_sections, count_tokens, split_text, tokenizer
from app.ingestion.context import ChunkContext
from app.ingestion.parsers import parse_document


def assert_coverage(text, ranges, size):
    assert ranges[0][0] == 0 and ranges[-1][1] == len(text)
    assert all(start < end and count_tokens(text[start:end]) <= size for start, end in ranges)
    assert all(left[0] < right[0] <= left[1] for left, right in zip(ranges, ranges[1:], strict=False))


@pytest.mark.parametrize("text", ["中文分块与原文定位😀。\n\n" * 300, "alpha 1.25 beta. next sentence!\n\n" * 300, "汉🙂a\t\n" * 700])
def test_unicode_token_windows_preserve_source_and_budget(text):
    ranges = split_text(text, 80, 12)
    assert_coverage(text, ranges, 80)
    assert ranges == split_text(text, 80, 12)


def test_code_and_small_table_are_atomic_but_large_rows_remain_bounded():
    code = "```python\n# This is code, not a heading\nprint('hello')\n```\n"
    table = "| 项目 | 名额 |\n| --- | --- |\n| 甲 | 12 |\n| 乙 | 15 |\n"
    text = "背景资料。" * 30 + "\n\n" + code + "\n" + table + "\n" + "结论。" * 30
    ranges = split_text(text, 90, 12)
    assert_coverage(text, ranges, 90)
    assert any(code in text[start:end] for start, end in ranges)
    assert any(table in text[start:end] for start, end in ranges)
    large = "| 名称 | 说明 |\n| --- | --- |\n" + "".join(f"| 项目{n} | 保留整行的真实事实 |\n" for n in range(35))
    ranges = split_text(large, 90, 12)
    assert_coverage(large, ranges, 90)
    for start, end in ranges:
        assert start == 0 or large[start - 1] == "\n"
        assert end == len(large) or large[end - 1] == "\n"


def test_oversized_fence_splits_without_losing_text():
    text = "```text\n" + "这是很长的代码示例里的文本。\n" * 150 + "```\n"
    assert_coverage(text, split_text(text, 80, 10), 80)


def test_chunking_tokenizes_remainder_only_once(monkeypatch):
    import app.ingestion.chunking as module
    encoding = tokenizer()
    measured = []

    class MeasuredEncoding:
        def encode(self, text, **options):
            measured.append(len(text))
            return encoding.encode(text, **options)

        def decode_with_offsets(self, tokens):
            return encoding.decode_with_offsets(tokens)

    monkeypatch.setattr(module, "tokenizer", lambda: MeasuredEncoding())
    text = "完整的研究段落保留事实与条件。\n\n" * 1200
    ranges = split_text(text, 200, 20)
    assert len(ranges) > 50
    # Count characters sent to the tokenizer, not machine-dependent milliseconds.
    # Binary-searching the complete remaining document per chunk was quadratic.
    assert sum(measured) < len(text) * 8


def test_fenced_markdown_hashes_do_not_create_false_sections(tmp_path):
    text = "# 项目\n前言\n```md\n# 假标题\n## 仍是代码\n```\n## 真正章节\n原始依据。\n"
    path = tmp_path / "headings.md"
    path.write_text(text, encoding="utf-8")
    parsed = parse_document(path)
    assert [section.heading for section in parsed.sections] == ["项目", "真正章节"]
    assert parsed.sections[1].parent_index == 0
    assert parsed.sections[1].anchor["line_start"] == 7
    for chunk in chunk_sections(parsed.sections, 80, 10):
        assert text[chunk.source_start:chunk.source_end] == chunk.content


def test_context_preserves_raw_passage_and_adds_heading_and_table_header():
    text = "| 项目 | 名额 |\n| --- | --- |\n| 甲 | 12 |\n| 乙 | 15 |\n"
    root = SimpleNamespace(id="root", heading="招生政策", parent_section_id=None, plain_text="总则", anchors={"source_start": 0})
    section = SimpleNamespace(id="child", heading="名额分配", parent_section_id="root", plain_text=text, anchors={"source_start": 100})
    raw = "| 乙 | 15 |\n"
    chunk = SimpleNamespace(section_id="child", content=raw, source_start=100 + text.index(raw))
    context = ChunkContext("规定.md", [root, section], context_tokens=96).text(chunk)
    assert context.endswith("\n\n" + raw)
    assert "招生政策 / 名额分配" in context
    assert "表头：| 项目 | 名额 |" in context
    assert count_tokens(context.removesuffix("\n\n" + raw)) <= 96
    assert chunk.content == raw
