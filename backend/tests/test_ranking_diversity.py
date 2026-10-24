"""Keep the bounded ranking algorithm equivalent while avoiding quadratic scans."""

import random
from collections import Counter
from types import SimpleNamespace

import pytest

from app.retrieval.ranking import _fingerprint, diversify


def reference_diversify(rows, scores):
    remaining, selected = set(scores), []
    counts, redundancy = Counter(), {}
    while remaining:
        key = min(remaining, key=lambda key: (
            -scores[key] * redundancy.get(key, 1) / (1 + 0.22 * counts[rows[key][0].document_id]), key,
        ))
        remaining.remove(key)
        selected.append(key)
        chunk = rows[key][0]
        counts[chunk.document_id] += 1
        current = _fingerprint(chunk.content)
        for other_key in remaining:
            other = rows[other_key][0]
            if other.document_id == chunk.document_id and other_key not in redundancy:
                other_fingerprint = _fingerprint(other.content)
                if len(current & other_fingerprint) / max(1, min(len(current), len(other_fingerprint))) > .65:
                    redundancy[other_key] = .35
    return selected


@pytest.mark.parametrize("documents,per_document", [(160, 1), (30, 20), (1, 100), (1, 600)])
def test_heap_diversity_preserves_reference_order_with_ties_and_repetition(documents, per_document):
    rng = random.Random(913)
    rows, scores = {}, {}
    for doc in range(documents):
        for index in range(per_document):
            key = f"{doc:03d}-{index:03d}"
            content = f"共同的重复段落对应文档{doc}。" * 10 if index % 3 else f"文档{doc}独立的信息与来源编号{index}。" * 10
            rows[key] = (SimpleNamespace(id=key, document_id=str(doc), content=content), None)
            scores[key] = rng.choice([0.0, .01, .03, .03, .07])
    assert diversify(rows, scores) == reference_diversify(rows, scores)


def test_diversity_empty_and_equal_scores_are_stable():
    assert diversify({}, {}) == []
    rows = {key: (SimpleNamespace(id=key, document_id=key, content="same"), None) for key in ("c", "a", "b")}
    assert diversify(rows, {"c": 1, "a": 1, "b": 1}) == ["a", "b", "c"]
