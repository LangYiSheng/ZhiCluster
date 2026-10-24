"""Reproducible BEIR lexical evaluation against the application's real search path.

Run with backend/.venv/Scripts/python scripts/retrieval_benchmark.py --download.
Only an in-memory SQLite database is used; model credentials and user data are not
loaded. Dataset archives and machine-readable runs remain in ignored .data/.
"""

import argparse
import csv
import hashlib
import importlib.util
import io
import json
import math
import os
import statistics
import sys
import time
import urllib.request
import zipfile
from pathlib import Path
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["APP_ENV"] = "test"

from sqlalchemy import create_engine, insert  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.config import Settings  # noqa: E402
from app.db.models import (  # noqa: E402
    Base,
    Document,
    DocumentChunk,
    DocumentSection,
    KnowledgeBase,
    KnowledgeBaseMember,
    User,
)
from app.retrieval.search import search_knowledge  # noqa: E402

DATASETS = {
    "scifact": {"md5": "5f7d1de60b170fc8027bb7898e2efca1", "bytes": 2816079},
    "nfcorpus": {"md5": "a89dba18a62ef92f7d323ec890a0d38d", "bytes": 2448432},
}
BASE_URL = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets"


def load_dataset(name, cache, download, split):
    archive = cache / f"{name}.zip"
    expected = DATASETS[name]
    if not archive.exists():
        if not download:
            raise SystemExit(f"Missing {archive}; pass --download to fetch the official BEIR archive")
        cache.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(f"{BASE_URL}/{name}.zip", headers={"User-Agent": "ZhiCluster retrieval benchmark"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read(expected["bytes"] + 1)
        except URLError as exc:
            raise SystemExit(f"Download failed: {exc}. Download {BASE_URL}/{name}.zip with your system TLS client "
                             f"to {archive}; the published hash is checked on the next run.") from exc
        if len(payload) != expected["bytes"] or hashlib.md5(payload).hexdigest() != expected["md5"]:
            raise SystemExit("Dataset integrity check failed; archive was not saved")
        archive.write_bytes(payload)
    payload = archive.read_bytes()
    if hashlib.md5(payload).hexdigest() != expected["md5"]:
        raise SystemExit("Cached dataset integrity check failed")
    with zipfile.ZipFile(io.BytesIO(payload)) as zipped:
        def rows(filename):
            return [json.loads(line) for line in zipped.read(f"{name}/{filename}").decode("utf-8").splitlines() if line]

        corpus = rows("corpus.jsonl")
        queries = {row["_id"]: row["text"] for row in rows("queries.jsonl")}
        qrels = {}
        reader = csv.DictReader(io.StringIO(zipped.read(f"{name}/qrels/{split}.tsv").decode()), delimiter="\t")
        for row in reader:
            score = int(row["score"])
            if score > 0:
                qrels.setdefault(row["query-id"], {})[row["corpus-id"]] = score
    return corpus, queries, qrels, hashlib.sha256(payload).hexdigest()


def metrics(ranking, relevant, k=10):
    ranking = list(dict.fromkeys(ranking))[:k]
    hits = [1 if doc in relevant else 0 for doc in ranking]
    recall = sum(hits) / len(relevant) if relevant else 0
    reciprocal = next((1 / rank for rank, hit in enumerate(hits, 1) if hit), 0)
    # BEIR/trec_eval uses linear relevance gains (not 2**grade - 1).
    dcg = sum(relevant.get(doc, 0) / math.log2(rank + 1) for rank, doc in enumerate(ranking, 1))
    ideal = sum(score / math.log2(rank + 1) for rank, score in enumerate(sorted(relevant.values(), reverse=True)[:k], 1))
    return {f"recall@{k}": recall, f"mrr@{k}": reciprocal, f"ndcg@{k}": dcg / ideal if ideal else 0}


def load_database(engine, corpus):
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        actor = User(id="benchmark-user", email="benchmark@localhost", display_name="Isolated benchmark")
        kb = KnowledgeBase(id="benchmark-kb", owner_id=actor.id, name="BEIR benchmark")
        db.add(actor)
        db.flush()
        db.add(kb)
        db.flush()
        db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
        db.flush()
        documents, sections, chunks = [], [], []
        for row in corpus:
            key = row["_id"]
            title = row.get("title") or key
            text = row["text"]
            documents.append({"id": key, "kb_id": kb.id, "owner_id": actor.id,
                              "display_name": title[:255], "original_filename": f"{key}.txt", "ext": "txt",
                              "mime_type": "text/plain", "size_bytes": len(text.encode()),
                              "storage_key": key, "sha256": hashlib.sha256(text.encode()).hexdigest(),
                              "parse_status": "ready", "index_status": "ready"})
            sections.append({"id": key, "kb_id": kb.id, "document_id": key, "plain_text": text,
                             "anchors": {"paragraph": 1}})
            chunks.append({"id": key, "kb_id": kb.id, "document_id": key, "section_id": key,
                           "chunk_index": 0, "content": text, "token_count": len(text.split()),
                           "anchors": {"paragraph": 1}})
        db.execute(insert(Document), documents)
        db.execute(insert(DocumentSection), sections)
        db.execute(insert(DocumentChunk), chunks)
        db.commit()


def search_implementation(source_dir):
    if source_dir:
        for name in ("terms", "ranking", "search"):
            full_name = f"app.retrieval.{name}"
            spec = importlib.util.spec_from_file_location(full_name, source_dir / f"{name}.py")
            module = importlib.util.module_from_spec(spec)
            sys.modules[full_name] = module
            spec.loader.exec_module(module)
        operation = sys.modules["app.retrieval.search"].search_knowledge
    else:
        operation = search_knowledge
    hashes = {}
    for name in ("terms", "ranking", "search"):
        source = Path(sys.modules[f"app.retrieval.{name}"].__file__)
        hashes[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    return operation, hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=DATASETS, default="scifact")
    parser.add_argument("--split", choices=("train", "dev", "test"), default="test")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--queries", type=int, default=0, help="0 evaluates every labeled query; otherwise sorted-ID prefix")
    parser.add_argument("--label", default="current")
    parser.add_argument("--source-dir", type=Path, help="Optional trusted snapshot directory with terms/ranking/search.py")
    parser.add_argument("--cache", type=Path, default=ROOT / ".data" / "retrieval-benchmark")
    args = parser.parse_args()
    search, source_hashes = search_implementation(args.source_dir)
    corpus, queries, qrels, digest = load_dataset(args.dataset, args.cache, args.download, args.split)
    engine = create_engine("sqlite://")
    load_database(engine, corpus)
    settings = Settings(_env_file=None, database_url="sqlite://", embedding_base_url="", embedding_model="",
                        embedding_api_key="", llm_base_url="", llm_model="", llm_api_key="")
    query_ids = sorted(qrels)
    if args.queries > 0:
        query_ids = query_ids[:args.queries]
    results = []
    with Session(engine, expire_on_commit=False) as db:
        actor = db.get(User, "benchmark-user")
        for index, query_id in enumerate(query_ids, 1):
            started = time.perf_counter()
            response = search(db, actor, {"query": queries[query_id], "kb_ids": ["benchmark-kb"],
                                         "mode": "keyword", "limit": 10}, settings)
            elapsed = (time.perf_counter() - started) * 1000
            ranking = [hit["document_id"] for hit in response["items"]]
            results.append({"query_id": query_id, "ranking": ranking, "elapsed_ms": round(elapsed, 2),
                            **metrics(ranking, qrels[query_id])})
            if index % 25 == 0 or index == len(query_ids):
                print(f"{args.dataset}/{args.split}: {index}/{len(query_ids)}", flush=True)
    times = sorted(row["elapsed_ms"] for row in results)
    summary = {key: statistics.mean(row[key] for row in results) for key in ("recall@10", "mrr@10", "ndcg@10")}
    summary.update({"latency_median_ms": statistics.median(times), "latency_p95_ms": times[max(0, math.ceil(len(times) * .95) - 1)]})
    run = {"dataset": args.dataset, "split": args.split, "label": args.label, "archive_sha256": digest,
           "corpus_documents": len(corpus), "queries": len(results), "mode": "keyword", "database": "isolated in-memory SQLite",
           "chunking": "one source abstract per chunk", "source_sha256": source_hashes,
           "summary": summary, "results": results}
    args.cache.mkdir(parents=True, exist_ok=True)
    output = args.cache / f"{args.dataset}-{args.split}-{args.label}.json"
    output.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output), **summary}, ensure_ascii=False, indent=2))
    engine.dispose()


if __name__ == "__main__":
    main()
