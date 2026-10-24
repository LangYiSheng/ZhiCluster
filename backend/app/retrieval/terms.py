"""Bounded, language-neutral query planning with a Chinese lexical fallback.

No model call or domain dictionary is required: each part of a compound question
gets a share of the candidate budget instead of truncating its trailing topic.
"""

import re
import unicodedata
from dataclasses import dataclass

_FILLER = re.compile(
    r"请问|请帮我|帮我|介绍一下|告诉我|我们|你们|他们|是什么|怎么样|怎么|如何|什么|多少|哪些|有没有|是否|以及|然后|还有|关于|一下|[的了吗呢呀是和与及]"
)
_WORD = re.compile(r"[\u3400-\u9fff]+|[a-z0-9][a-z0-9_.+#/%-]*", re.IGNORECASE)
_ENGLISH_FILLER = frozenset(
    "a an and are as at be been being by can could did do does for from had has have how "
    "i if in into is it its may me might my of on or our please should than that the their "
    "them there these they this those to us was we were what when where which who why will "
    "with would you your".split()
)


def normalized(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def escape_like(text: str) -> str:
    """Treat user-supplied %, _ and backslashes as literal text in SQL LIKE."""
    return text.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")


@dataclass(frozen=True)
class QueryPlan:
    query: str
    terms: tuple[str, ...]
    groups: tuple[tuple[str, ...], ...]


def _spread(values: list[str]) -> list[str]:
    """Visit both ends and the middle before filling a long unsegmented run."""
    if len(values) < 4:
        return values
    indices = list(dict.fromkeys([0, len(values) - 1, len(values) // 2]))
    indices.extend(index for index in range(len(values)) if index not in indices)
    return [values[index] for index in indices]


def plan_query(query: str, max_terms: int = 48) -> QueryPlan:
    query = normalized(query.strip())
    groups = []
    for match in _WORD.finditer(_FILLER.sub(" ", query)):
        word = match.group().strip(".-/")
        if not word or word in _ENGLISH_FILLER:
            continue
        if re.fullmatch(r"[\u3400-\u9fff]+", word):
            if len(word) == 1:
                continue
            phrases = [word] if len(word) <= 16 else []
            # Interleave sizes; do not spend the entire budget on trigrams from
            # the first phrase while losing a short final topic.
            grams = [_spread([word[i:i + size] for i in range(len(word) - size + 1)]) for size in (3, 2)]
            for index in range(max(map(len, grams), default=0)):
                phrases.extend(gram[index] for gram in grams if index < len(gram))
        else:
            phrases = [word]
        groups.append(tuple(dict.fromkeys(phrases)))
    terms = [query] if len(query) <= 80 else []
    for index in range(max(map(len, groups), default=0)):
        for group in groups:
            if index < len(group) and group[index] not in terms:
                terms.append(group[index])
                if len(terms) >= max_terms:
                    break
        if len(terms) >= max_terms:
            break
    terms = terms or [query]
    included = set(terms)
    return QueryPlan(query, tuple(terms), tuple(tuple(term for term in group if term in included) for group in groups))


def term_weight(term: str, query: str) -> float:
    if term == query:
        return 2.0
    return 0.8 if len(term) == 2 else 1.0 if len(term) == 3 else 1.35


def semantic_queries(query: str) -> list[str]:
    """Embed compound questions as a batch, without another provider round trip.

    Keep the full question for context and at most two self-contained clauses.
    This prevents a named entity in the second question from dominating the
    embedding used to find evidence for the first one.
    """
    clauses = [part.strip() for part in re.split(r"[，,。?？!！;；\n]+", query) if len(part.strip()) >= 6]
    clauses = list(dict.fromkeys(clauses))
    if len(clauses) < 2:
        return [query]
    return list(dict.fromkeys([query, clauses[0], clauses[-1]]))
