"""CMRC2018 source retrieval through real uploads, worker and HTTP search.

Use only an isolated instance with AI disabled. No model calls or answers are
generated. Original corpus/results stay under ignored .data, never in Git.
"""

import argparse
import hashlib
import json
import random
import statistics
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "https://raw.githubusercontent.com/ymcui/cmrc2018/master/squad-style-data/cmrc2018_dev.json"
SHA256 = "e9ff74231f05c230c6fa88b84441ee334d97234cbb610991cd94b82db00c7f1f"


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_corpus(path):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SHA256:
        raise ValueError("Dataset checksum changed; verify the upstream revision before benchmarking")
    corpus, questions = {}, []
    for article in json.loads(raw)["data"]:
        for paragraph in article["paragraphs"]:
            context = paragraph["context"]
            key = hashlib.sha256(context.encode()).hexdigest()
            corpus.setdefault(key, {"title": article["title"], "context": context})
            for qa in paragraph["qas"]:
                questions.append({"id": qa["id"], "query": qa["question"], "key": key,
                                  "answers": sorted({answer["text"] for answer in qa["answers"]})})
    return corpus, questions


def retrieval_metrics(items, expected_id, answers):
    documents = list(dict.fromkeys(item["document_id"] for item in items))[:10]
    rank = documents.index(expected_id) + 1 if expected_id in documents else None
    evidence = any(item["document_id"] == expected_id and any(answer in item["content"] for answer in answers)
                   for item in items[:5])
    return {"recall_at_1": float(rank == 1), "recall_at_5": float(rank is not None and rank <= 5),
            "recall_at_10": float(rank is not None), "mrr_at_10": 1 / rank if rank else 0,
            "answer_evidence_at_5_chunks": float(evidence), "rank": rank,
            "documents": documents}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:13000")
    parser.add_argument("--workdir", type=Path, default=ROOT / ".data" / "continuous-optimization")
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--queries", type=int, default=300)
    parser.add_argument("--seed", type=int, default=20261024)
    parser.add_argument("--label", default="baseline")
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()
    parsed = urlsplit(args.url)
    if parsed.hostname not in {"localhost", "127.0.0.1"} or parsed.port not in {13000, 18000}:
        parser.error("Only the isolated local evaluation ports 13000/18000 are allowed")
    if args.queries < 1 or not args.label.replace("-", "").replace("_", "").isalnum():
        parser.error("queries must be positive; label must be a simple file name")
    args.workdir.mkdir(parents=True, exist_ok=True)
    dataset = args.dataset or args.workdir / "cmrc2018_dev.json"
    state_path = args.workdir / "cmrc-state.json"
    with httpx.Client(base_url=args.url, timeout=60) as client:
        def api(method, path, **kwargs):
            response = client.request(method, "/api" + path, **kwargs)
            response.raise_for_status()
            return response.json()

        status = api("GET", "/settings/model-status")
        if status["llm"]["configured"] or status["embedding"]["configured"]:
            raise ValueError("Refusing a benchmark against an instance with model connections configured")
        if args.cleanup:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            kb = api("GET", f"/knowledge-bases/{state['kb_id']}")
            if state["url"] != args.url or kb["name"] != state["name"]:
                raise ValueError("Saved fixture identity does not match the evaluation instance")
            api("DELETE", f"/knowledge-bases/{state['kb_id']}")
            result = api("POST", "/trash/purge", json={"kind": "knowledge_base", "ids": [state["kb_id"]], "confirm": True})
            state_path.unlink()
            print(json.dumps(result))
            return
        if args.download and not dataset.exists():
            response = httpx.get(SOURCE, timeout=60, follow_redirects=True)
            response.raise_for_status()
            dataset.write_bytes(response.content)
        corpus, questions = load_corpus(dataset)
        if state_path.exists():
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if state["url"] != args.url or state["sha256"] != SHA256:
                raise ValueError("Use a different workdir for a different dataset or instance")
            api("GET", f"/knowledge-bases/{state['kb_id']}")
        else:
            name = "一次性检索评估 CMRC2018 " + str(time.time_ns())
            kb = api("POST", "/knowledge-bases", json={"name": name,
                     "description": "CMRC2018 开发集，CC BY-SA 4.0；隔离评估专用，可按保存的精确ID清理。"})
            state = {"url": args.url, "sha256": SHA256, "kb_id": kb["id"], "name": name, "documents": {}}
            write_json(state_path, state)
        entries = [(key, entry) for key, entry in corpus.items() if key not in state["documents"]]
        started = time.monotonic()
        for start in range(0, len(entries), 20):
            batch = entries[start:start + 20]
            result = api("POST", f"/knowledge-bases/{state['kb_id']}/uploads", files=[
                ("files", (f"{key[:12]}.md", f"# {entry['title']}\n\n{entry['context']}".encode(), "text/markdown"))
                for key, entry in batch])
            if len(result["items"]) != len(batch) or any(item["status"] not in {"queued", "duplicate"} for item in result["items"]):
                raise ValueError(f"Upload failed: {result}")
            for (key, _), item in zip(batch, result["items"], strict=True):
                state["documents"][key] = item["document"]["id"]
            write_json(state_path, state)
            print(f"Uploaded {len(state['documents'])}/{len(corpus)}", flush=True)
        deadline = time.monotonic() + 600
        while True:
            documents = []
            for page in range(1, (len(corpus) + 199) // 200 + 1):
                documents.extend(api("GET", f"/knowledge-bases/{state['kb_id']}/documents", params={"page": page, "page_size": 200})["items"])
            failed = [doc for doc in documents if doc["parse_status"] == "failed"]
            if failed:
                raise ValueError(f"Real worker parsing failed for {len(failed)} documents")
            ready = sum(doc["parse_status"] == "ready" for doc in documents)
            if ready == len(corpus):
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Worker ready deadline: {ready}/{len(corpus)}")
            print(f"Parsed {ready}/{len(corpus)}", flush=True)
            time.sleep(1)
        ingestion_elapsed = time.monotonic() - started if entries else None
        selected = random.Random(args.seed).sample(questions, min(args.queries, len(questions)))
        rows = []
        for index, question in enumerate(selected):
            before = time.monotonic()
            result = api("POST", "/search", json={"query": question["query"], "kb_ids": [state["kb_id"]],
                         "mode": "keyword", "limit": 30, "rerank": False})
            rows.append({**question, "elapsed_ms": (time.monotonic() - before) * 1000,
                         "server_elapsed_ms": result["elapsed_ms"],
                         **retrieval_metrics(result["items"], state["documents"][question["key"]], question["answers"])})
            if (index + 1) % 25 == 0:
                print(f"Evaluated {index + 1}/{len(selected)}", flush=True)
        durations = sorted(row["elapsed_ms"] for row in rows)
        output = {"source": SOURCE, "license": "CC BY-SA 4.0", "sha256": SHA256, "seed": args.seed,
                  "corpus_documents": len(corpus), "available_questions": len(questions), "queries": len(rows),
                  "mode": "keyword; real HTTP upload/worker; no embeddings or LLM", "limit": 30,
                  "initial_upload_and_parse_seconds": ingestion_elapsed,
                  "metrics": {key: statistics.mean(row[key] for row in rows) for key in (
                      "recall_at_1", "recall_at_5", "recall_at_10", "mrr_at_10", "answer_evidence_at_5_chunks")},
                  "latency_ms": {"median": statistics.median(durations), "p95": durations[max(0, int(len(rows) * .95) - 1)]},
                  "rows": rows}
        write_json(args.workdir / f"cmrc-{args.label}.json", output)
        print(json.dumps({key: value for key, value in output.items() if key != "rows"}, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
