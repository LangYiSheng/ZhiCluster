"""Check evaluation math independently of ranking quality or a live server."""

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("benchmark_cmrc", Path(__file__).resolve().parents[2] / "scripts" / "benchmark_cmrc.py")
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def item(document, text="evidence"):
    return {"document_id": document, "content": text}


def test_metrics_count_unique_documents_but_answer_support_uses_actual_chunks():
    rows = [item("other", "answer")] * 5 + [item("expected", "answer")]
    scores = benchmark.retrieval_metrics(rows, "expected", ["answer"])
    assert scores["rank"] == 2 and scores["mrr_at_10"] == 0.5
    assert scores["recall_at_1"] == 0 and scores["recall_at_5"] == 1
    assert scores["answer_evidence_at_5_chunks"] == 0


def test_wrong_source_with_matching_answer_is_not_evidence():
    scores = benchmark.retrieval_metrics([item("other", "answer"), item("expected", "unrelated")], "expected", ["answer"])
    assert scores["answer_evidence_at_5_chunks"] == 0
    assert scores["recall_at_10"] == 1


def test_rank_after_ten_unique_documents_does_not_inflate_at_ten_metrics():
    rows = [item(str(index)) for index in range(10)] + [item("expected", "answer")]
    scores = benchmark.retrieval_metrics(rows, "expected", ["answer"])
    assert scores["rank"] is None and scores["mrr_at_10"] == 0 and scores["recall_at_10"] == 0


def test_empty_results_and_alternative_answer_spans():
    assert benchmark.retrieval_metrics([], "expected", ["answer"])["recall_at_5"] == 0
    assert benchmark.retrieval_metrics([item("expected", "alternative")], "expected", ["answer", "alternative"])["answer_evidence_at_5_chunks"] == 1


def test_resume_rejects_revision_settings_and_query_sequence_changes():
    identity = {"revision": "old-image", "seed": 42}
    saved = {"identity": identity, "rows": [{"id": "q1"}]}
    assert benchmark.validate_checkpoint(saved, identity, [{"id": "q1"}, {"id": "q2"}]) == [{"id": "q1"}]
    with pytest.raises(ValueError, match="settings changed"):
        benchmark.validate_checkpoint(saved, {**identity, "revision": "new-image"}, [{"id": "q1"}])
    with pytest.raises(ValueError, match="sequence"):
        benchmark.validate_checkpoint(saved, identity, [{"id": "q2"}])


def test_mrc_loader_checks_selected_source_hash_and_keeps_context_question_mapping(tmp_path):
    payload = {"data": [{"title": "繁體來源", "paragraphs": [
        {"context": "同一段原文", "qas": [{"id": "one", "question": "原文問題一", "answers": [{"text": "原文"}, {"text": "原文"}]}]},
        {"context": "同一段原文", "qas": [{"id": "two", "question": "原文問題二", "answers": [{"text": "一段"}]}]},
    ]}]}
    path = tmp_path / "dataset.json"
    raw = json.dumps(payload, ensure_ascii=False).encode()
    path.write_bytes(raw)
    with pytest.raises(ValueError, match="checksum"):
        benchmark.load_corpus(path)
    corpus, questions = benchmark.load_corpus(path, hashlib.sha256(raw).hexdigest())
    assert len(corpus) == 1 and len(questions) == 2
    assert questions[0]["key"] == questions[1]["key"] == next(iter(corpus))
    assert corpus[questions[0]["key"]] == {"title": "繁體來源", "context": "同一段原文"}
    assert questions[0]["answers"] == ["原文"] and questions[1]["answers"] == ["一段"]
