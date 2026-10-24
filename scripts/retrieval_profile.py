"""Compare trusted retrieval snapshots on isolated CMRC data in read-only PG.

Provide the connection URL through PG_RETRIEVAL_PROFILE_URL, never a CLI flag.
Only loopback port 25432/zhicluster, or an explicitly named *_test database, is
accepted. No .env or saved model configuration is loaded. This does not change
the running API or create/migrate tables.
"""

import argparse
import functools
import hashlib
import importlib.util
import json
import os
import random
import re
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from sqlalchemy import create_engine, event, func, select  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

PHASES = {
    "_candidates": "candidate_fetch", "lexical_scores": "lexical_scoring",
    "_current_candidates": "access_recheck", "scoped_query": "initial_scope",
    "diversify": "diversity", "plan_query": "query_planning", "snippet": "snippets",
    "fuse_rankings": "fusion", "document_purpose_weight": "purpose_prior",
}


def validate_profile_target(value, test_database=None):
    """Reject ordinary DBs, remote hosts and query-string routing overrides."""
    try:
        url = make_url(value)
    except Exception:
        raise ValueError("Profile URL must be a PostgreSQL SQLAlchemy URL") from None
    if url.drivername not in {"postgresql", "postgresql+psycopg"}:
        raise ValueError("Only PostgreSQL/psycopg profiling is supported")
    if url.host not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Profiling requires a loopback database host")
    routing = {"host", "hostaddr", "port", "dbname", "database", "service", "servicefile", "options"}
    if routing.intersection(key.casefold() for key in url.query):
        raise ValueError("Connection routing and options must not be overridden in the URL query")
    evaluation = url.port == 25432 and url.database == "zhicluster"
    dedicated = (test_database is not None and re.fullmatch(r"[a-z][a-z0-9_]*_test", test_database)
                 and url.database == test_database)
    if not evaluation and not dedicated:
        raise ValueError("Use local 25432/zhicluster or explicitly select the matching *_test database")
    # The project ships psycopg 3; a plain PostgreSQL URL must not select an
    # unrelated optional driver through SQLAlchemy's default-driver fallback.
    url = url.set(drivername="postgresql+psycopg")
    public = {"host": url.host, "port": url.port or 5432, "database": url.database}
    return url, public


def load_snapshot(directory):
    """Execute only a caller-selected, trusted local snapshot; hash exact bytes."""
    import app.retrieval

    hashes = {}
    for name in ("terms", "ranking", "search"):
        path = directory.resolve() / f"{name}.py"
        payload = path.read_bytes()
        hashes[name] = hashlib.sha256(payload).hexdigest()
        full_name = f"app.retrieval.{name}"
        spec = importlib.util.spec_from_file_location(full_name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[full_name] = module
        setattr(app.retrieval, name, module)
        exec(compile(payload, str(path), "exec"), module.__dict__)
    return module, hashes


def response_signature(response):
    stable = {key: value for key, value in response.items() if key != "elapsed_ms"}
    payload = json.dumps(stable, sort_keys=True, allow_nan=False).encode()
    return hashlib.sha256(payload).hexdigest()


def unchanged_sources(directories, expected):
    try:
        return all(hashlib.sha256((directory / f"{name}.py").read_bytes()).hexdigest() == digest
                   for label, directory in directories.items() for name, digest in expected[label].items())
    except OSError:
        return False


class PhaseMeter:
    def __init__(self, engine):
        self.stack = []
        self.reset()
        event.listen(engine, "before_cursor_execute", self.before)
        event.listen(engine, "after_cursor_execute", self.after)

    def reset(self):
        self.stage_ms, self.sql_ms = defaultdict(float), defaultdict(float)
        self.stage_counts, self.sql_counts = Counter(), Counter()
        self.captured = []

    def instrument(self, module):
        for name, label in PHASES.items():
            operation = getattr(module, name)
            setattr(module, name, self.measured(operation, label))

    def measured(self, operation, label):
        @functools.wraps(operation)
        def call(*args, **kwargs):
            # Attribute nested scope validation to access_recheck once.
            if self.stack:
                return operation(*args, **kwargs)
            self.stack.append(label)
            started = time.perf_counter()
            try:
                return operation(*args, **kwargs)
            finally:
                self.stage_ms[label] += (time.perf_counter() - started) * 1000
                self.stage_counts[label] += 1
                self.stack.pop()
        return call

    def before(self, _connection, _cursor, statement, parameters, context, _many):
        label = self.stack[-1] if self.stack else "other"
        context._retrieval_profile_start = (time.perf_counter(), label)
        if label == "candidate_fetch" and statement.lstrip().startswith(("SELECT", "WITH")):
            self.captured.append((statement, parameters))

    def after(self, _connection, _cursor, _statement, _parameters, context, _many):
        started, label = context._retrieval_profile_start
        self.sql_ms[label] += (time.perf_counter() - started) * 1000
        self.sql_counts[label] += 1


def summarize(runs):
    summary = {}
    for label in ("baseline", "candidate"):
        rows = [row for row in runs if row["variant"] == label]
        if not rows:
            continue
        phases = sorted({phase for row in rows for phase in row["stage_ms"]})
        summary[label] = {
            "requests": len(rows),
            "median_total_ms": statistics.median(row["total_ms"] for row in rows),
            "mean_total_ms": statistics.mean(row["total_ms"] for row in rows),
            "mean_candidate_fetch_ms": statistics.mean(row["stage_ms"].get("candidate_fetch", 0) for row in rows),
            "mean_candidate_db_roundtrip_ms": statistics.mean(row["db_roundtrip_ms"].get("candidate_fetch", 0) for row in rows),
            "mean_stage_ms": {phase: statistics.mean(row["stage_ms"].get(phase, 0) for row in rows) for phase in phases},
        }
    return summary


def load_questions(dataset):
    path = ROOT / "scripts" / "benchmark_cmrc.py"
    spec = importlib.util.spec_from_file_location("_profile_cmrc_input", path)
    source = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(source)
    _, questions = source.load_corpus(dataset)
    return questions, source.SHA256


def profile(args):
    # These imports occur only during an explicit run, not when checking guards.
    from app.core.config import Settings
    from app.db.models import Document, DocumentChunk, KnowledgeBase, User

    value = os.environ.get("PG_RETRIEVAL_PROFILE_URL", "")
    url, public_target = validate_profile_target(value, args.test_database)
    state = json.loads(args.state.read_text(encoding="utf-8"))
    valid_origins = {f"http://{host}:{port}" for host in ("localhost", "127.0.0.1") for port in (13000, 18000)}
    if state.get("url") not in valid_origins or not state.get("name", "").startswith("一次性检索评估 CMRC2018 "):
        raise ValueError("State must identify a CMRC fixture on an isolated evaluation API")
    questions, digest = load_questions(args.dataset)
    if state.get("sha256") != digest or not 1 <= args.queries <= len(questions):
        raise ValueError("Dataset identity or requested query count is invalid")
    selected = random.Random(args.seed).sample(questions, args.queries)
    if args.output.exists():
        raise FileExistsError("Refusing to overwrite an earlier profile")
    directories = {"baseline": args.baseline_source.resolve(), "candidate": args.candidate_source.resolve()}
    modules, hashes = {}, {}
    for label, directory in directories.items():
        modules[label], hashes[label] = load_snapshot(directory)
    settings = Settings(_env_file=None, app_env="test", database_url="sqlite://",
                        embedding_base_url="", embedding_api_key="", embedding_model="",
                        llm_base_url="", llm_api_key="", llm_model="")
    engine = create_engine(url)
    meter = PhaseMeter(engine)
    for module in modules.values():
        meter.instrument(module)
    report = {"target": public_target, "readonly": False, "completed": False, "seed": args.seed,
              "queries": args.queries, "repeats": args.repeats, "limit": args.limit, "mode": "keyword; no models",
              "dataset_sha256": digest, "source_sha256": hashes, "snapshot_paths": {key: str(path) for key, path in directories.items()},
              "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "interleaved": True, "runs": [], "plans": {}, "mismatched_queries": []}
    samples = {}
    try:
        with engine.connect() as connection, connection.begin():
            connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            connection.exec_driver_sql("SELECT set_config('statement_timeout', %s, true)", (f"{args.timeout_ms}ms",))
            report["readonly"] = connection.exec_driver_sql("SHOW transaction_read_only").scalar_one() == "on"
            report["transaction_isolation"] = connection.exec_driver_sql("SHOW transaction_isolation").scalar_one()
            if not report["readonly"]:
                raise ValueError("Read-only transaction was not established")
            with Session(bind=connection, expire_on_commit=False) as db:
                kb = db.get(KnowledgeBase, state["kb_id"])
                if not kb or kb.name != state["name"]:
                    raise ValueError("Database does not contain the exact expected CMRC fixture")
                actor = db.get(User, kb.owner_id)
                report.update({"kb_id": kb.id, "documents": db.scalar(select(func.count(Document.id)).where(Document.kb_id == kb.id)),
                               "chunks": db.scalar(select(func.count(DocumentChunk.id)).where(DocumentChunk.kb_id == kb.id))})
                for index, question in enumerate(selected):
                    signatures = set()
                    for repeat in range(args.repeats):
                        order = list(modules) if (index + repeat) % 2 == 0 else list(reversed(modules))
                        for label in order:
                            meter.reset()
                            started = time.perf_counter()
                            response = modules[label].search_knowledge(db, actor, {
                                "query": question["query"], "kb_ids": [kb.id], "mode": "keyword", "limit": args.limit,
                            }, settings)
                            elapsed = (time.perf_counter() - started) * 1000
                            signature = response_signature(response)
                            signatures.add(signature)
                            report["runs"].append({"query_index": index, "query_id": question["id"], "repeat": repeat,
                                "variant": label, "total_ms": elapsed, "candidate_count": response["total"],
                                "signature": signature, "stage_ms": dict(meter.stage_ms), "stage_counts": dict(meter.stage_counts),
                                "db_roundtrip_ms": dict(meter.sql_ms), "db_statement_counts": dict(meter.sql_counts),
                                "unattributed_ms": elapsed - sum(meter.stage_ms.values())})
                            if meter.captured:
                                samples[index, label] = meter.captured[0]
                    if len(signatures) != 1:
                        report["mismatched_queries"].append(question["id"])
                    print(f"Profiled {index + 1}/{len(selected)}", flush=True)
                # EXPLAIN runs after timings to avoid favoring the next variant.
                if args.explain:
                    for (index, label), (statement, parameters) in samples.items():
                        report["plans"][f"{index}:{label}"] = connection.exec_driver_sql(
                            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement, parameters,
                        ).scalar_one()
        report["completed"] = True
    except Exception as error:
        # Driver errors can contain URLs/parameters; retain only their type.
        report["error_type"] = type(error).__name__
    finally:
        engine.dispose()
    report["source_files_unchanged"] = unchanged_sources(directories, hashes)
    report["identical_response_signatures"] = not report["mismatched_queries"] and report["completed"]
    report["summary"] = summarize(report["runs"])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
    print(json.dumps({"output": str(args.output), "completed": report["completed"],
                      "identical_response_signatures": report["identical_response_signatures"],
                      "source_files_unchanged": report["source_files_unchanged"], "summary": report["summary"]}, indent=2))
    return 0 if report["completed"] and report["identical_response_signatures"] and report["source_files_unchanged"] else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-source", type=Path, required=True, help="Trusted directory containing terms/ranking/search.py")
    parser.add_argument("--candidate-source", type=Path, required=True, help="Trusted directory containing terms/ranking/search.py")
    parser.add_argument("--test-database", help="Explicit matching *_test DB, required outside local evaluation 25432/zhicluster")
    parser.add_argument("--state", type=Path, default=ROOT / ".data/continuous-optimization/cmrc-state.json")
    parser.add_argument("--dataset", type=Path, default=ROOT / ".data/continuous-optimization/cmrc2018_dev.json")
    parser.add_argument("--queries", type=int, default=12)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seed", type=int, default=20261024)
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--timeout-ms", type=int, default=10000)
    parser.add_argument("--explain", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--output", type=Path, default=ROOT / f".data/retrieval-benchmark/profile-{time.time_ns()}.json")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10 or not 1 <= args.limit <= 100 or not 1 <= args.timeout_ms <= 60000:
        parser.error("repeats must be 1..10, limit 1..100, timeout-ms 1..60000")
    try:
        return profile(args)
    except Exception as error:
        print(f"Profiling stopped ({type(error).__name__}); connection URLs and driver details are not printed.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
