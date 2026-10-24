"""Local evidence reranking, independent of database and embedding providers."""

import math
import re
from collections import Counter
from heapq import heapify, heappop, heappush

from app.retrieval.terms import QueryPlan, normalized, term_weight

_FORM_PURPOSE = re.compile(
    r"(?:申请|申报|登记|报名|审批|备案|报销|志愿)(?:信息)?表|问卷|样表|表格模板|空白模板|"
    r"\b(?:application|registration|approval|request|expense)\s+forms?\b|\b(?:templates?|questionnaires?)\b"
)
_FORM_REQUEST = re.compile(
    r"申请表|申报表|登记表|报名表|审批表|备案表|报销表|志愿表|问卷|模板|表格|表单|填[写报表]|签名|签字|[这那此][张份个]?表|"
    r"\b(?:forms?|templates?|questionnaires?|fill|filling|signature|sign)\b"
)
_DATA_OR_GUIDE = re.compile(
    r"统计|汇总|明细|数据表|分配表|台账|清单|填写说明|填表说明|填写指南|填表指南|填报指南|"
    r"\b(?:statistics|summary|dataset|guide|instructions)\b"
)


def document_purpose_weight(document, query: str) -> float:
    """Softly prefer factual evidence over forms for general questions.

    This is a generic document-purpose prior, not a subject/domain dictionary.
    It requires no generated summary or extra network request. Data tables and
    guides remain evidence; explicit requests for a form keep their usual rank.
    """
    title, question = normalized(document.display_name), normalized(query)
    if _FORM_REQUEST.search(question) or _DATA_OR_GUIDE.search(title):
        return 1.0
    return 0.4 if _FORM_PURPOSE.search(title) else 1.0


def lexical_scores(rows, plan: QueryPlan) -> dict[str, float]:
    if not rows:
        return {}
    texts = {row[0].id: normalized(row[0].content) for row in rows}
    # Share occurrence counts between corpus frequency, BM25 and group coverage
    # instead of repeatedly scanning every passage for the same term.
    counts = {key: {term: text.count(term) for term in plan.terms} for key, text in texts.items()}
    frequency = {term: sum(bool(counts[key][term]) for key in texts) for term in plan.terms}
    average_length = sum(len(text) for text in texts.values()) / len(texts)
    groups = [group for group in plan.groups if group]
    scores = {}
    for chunk, document, *_ in rows:
        text, title = texts[chunk.id], normalized(document.display_name)
        norm = 1.2 * (0.25 + 0.75 * len(text) / max(average_length, 1))
        body_score, title_score = 0.0, 0.0
        for term in plan.terms:
            # Rare terms in actual bodies discriminate evidence from repeated
            # headers; filename matches are capped supplementary signals.
            idf = math.log(1 + (len(texts) - frequency[term] + 0.5) / (frequency[term] + 0.5))
            weight = idf * term_weight(term, plan.query)
            count = min(4, counts[chunk.id][term])
            body_score += weight * count * 2.2 / (count + norm) if count else 0
            title_score += weight if term in title else 0
        coverage = sum(sum(bool(counts[chunk.id][term]) for term in group) / len(group) for group in groups) / len(groups) if groups else float(plan.query in text)
        # A title-only hit remains discoverable by filename, but an empty form
        # cannot outrank a passage actually answering the same query.
        scores[chunk.id] = body_score * (0.7 + coverage) + min(title_score * 0.12, 1.25)
    return scores


def fuse_rankings(keyword_ranking, vector_rankings, lexical: dict[str, float]) -> dict[str, float]:
    """Use rank fusion while retaining the strength of actual lexical evidence."""
    scores = {}
    channels = [(keyword_ranking, 1.0)]
    channels.extend((ranking, 1 / len(vector_rankings)) for ranking in vector_rankings)
    for ranking, weight in channels:
        for rank, key in enumerate(dict.fromkeys(ranking), 1):
            scores[key] = scores.get(key, 0) + weight / (40 + rank)
    maximum = max(lexical.values(), default=0)
    if maximum:
        for key in scores:
            scores[key] += 0.012 * lexical.get(key, 0) / maximum
    return scores


def _fingerprint(text: str) -> set[str]:
    text = "".join(normalized(text).split())
    return {text[index:index + 5] for index in range(max(1, len(text) - 4))}


def diversify(rows_by_id, scores: dict[str, float]) -> list[str]:
    """Discount repeated chunks without forcing unrelated documents into hits.

    Selection remains deterministic and preserves original chunks/anchors. Long
    documents may still contribute several complementary passages.
    """
    selected = []
    counts: Counter = Counter()
    fingerprints = {}
    redundancy = {}
    document_chunks = {}
    for key in scores:
        document_chunks.setdefault(rows_by_id[key][0].document_id, set()).add(key)
    # Only a document's best remaining chunk competes globally: all chunks in
    # that document share the same count penalty. This bounds the heap by the
    # document count and avoids accumulating stale entries for a long document.
    queue = []
    for siblings in document_chunks.values():
        key = min(siblings, key=lambda key: (-scores[key], key))
        queue.append((-scores[key], key))
    heapify(queue)
    while queue:
        _, key = heappop(queue)
        chunk = rows_by_id[key][0]
        selected.append(key)
        counts[chunk.document_id] += 1
        siblings = document_chunks[chunk.document_id]
        siblings.remove(key)
        if siblings:
            if key not in fingerprints:
                fingerprints[key] = _fingerprint(chunk.content)
            current = fingerprints[key]
            for other_key in siblings:
                if other_key not in redundancy:
                    if other_key not in fingerprints:
                        fingerprints[other_key] = _fingerprint(rows_by_id[other_key][0].content)
                    other = fingerprints[other_key]
                    overlap = len(current & other) / max(1, min(len(current), len(other)))
                    if overlap > 0.65:
                        redundancy[other_key] = 0.35
            divisor = 1 + 0.22 * counts[chunk.document_id]
            next_key = min(siblings, key=lambda other_key: (
                -scores[other_key] * redundancy.get(other_key, 1) / divisor, other_key,
            ))
            adjusted = scores[next_key] * redundancy.get(next_key, 1) / divisor
            heappush(queue, (-adjusted, next_key))
    return selected


def snippet(content: str, plan: QueryPlan, length: int = 700) -> str:
    """Center a result preview around evidence rather than always the page top."""
    folded = normalized(content)
    locations = [(folded.find(term), len(term)) for term in plan.terms if term in folded]
    if not locations:
        return content[:length]
    # Prefer an exact phrase, then the earliest useful lexical match. NFKC may
    # alter character counts, so clamp the preview rather than emitting offsets.
    exact = folded.find(plan.query)
    position = exact if exact >= 0 else min(locations, key=lambda match: (-match[1], match[0]))[0]
    start = min(max(0, position - 100), max(0, len(content) - length))
    return content[start:start + length]
