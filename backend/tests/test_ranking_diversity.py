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
                if len(current & other_fingerprint) / max(1, len(other_fingerprint)) > .65:
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


def directional_rows(selected, candidate):
    return {
        "selected": (SimpleNamespace(id="selected", document_id="same", content=selected), None),
        "candidate": (SimpleNamespace(id="candidate", document_id="same", content=candidate), None),
        "other": (SimpleNamespace(id="other", document_id="different", content="另一份独立证据"), None),
    }


@pytest.mark.parametrize("selected_length,candidate_length,expected", [
    (100, 300, ["selected", "candidate", "other"]),
    (300, 100, ["selected", "other", "candidate"]),
])
def test_coverage_direction_preserves_new_body_but_discounts_covered_tail(selected_length, candidate_length, expected):
    # Unique characters produce a short passage contained in a much larger
    # passage, without repeated filler dominating its fingerprint set.
    body = "".join(chr(0x4E00 + index) for index in range(300))
    rows = directional_rows(body[:selected_length], body[:candidate_length])
    scores = {"selected": 1.0, "candidate": .99, "other": .8}
    assert diversify(rows, scores) == expected
    assert diversify(rows, scores) == reference_diversify(rows, scores)


def test_genuine_near_duplicate_body_is_still_discounted():
    body = "".join(chr(0x4E00 + index) for index in range(300))
    rows = directional_rows(body, body[:-10] + "xyzxyzxyzx")
    scores = {"selected": 1.0, "candidate": .99, "other": .8}
    assert diversify(rows, scores) == ["selected", "other", "candidate"]
    assert diversify(rows, scores) == reference_diversify(rows, scores)


def test_directional_diversity_is_stable_across_input_mapping_order():
    body = "".join(chr(0x4E00 + index) for index in range(300))
    rows = directional_rows(body[:100], body)
    scores = {"selected": 1.0, "candidate": .99, "other": .8}
    rng = random.Random(147)
    for _ in range(12):
        row_items, score_items = list(rows.items()), list(scores.items())
        rng.shuffle(row_items)
        rng.shuffle(score_items)
        assert diversify(dict(row_items), dict(score_items)) == ["selected", "candidate", "other"]
