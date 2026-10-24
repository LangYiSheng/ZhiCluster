"""Repeatable synthetic metadata benchmark. Never connects to the configured DB."""

import argparse
import json
import os
import statistics
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["APP_ENV"] = "test"

from sqlalchemy import create_engine, event, select  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.api.library import delete_folder, documents  # noqa: E402
from app.db.models import Base, Document, DocumentTag, Folder, KnowledgeBase, Tag  # noqa: E402
from app.db.seed import seed  # noqa: E402
from app.services.library import descendants  # noqa: E402
from app.services.permissions import DEMO_USER_ID  # noqa: E402


def run(depth=3000, count=200, repeats=5):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as db:
        seed(db)
        kb = db.scalar(select(KnowledgeBase))
        db.add_all(Folder(id=f"depth-{n}", kb_id=kb.id, name=str(n), parent_id=f"depth-{n - 1}" if n else None)
            for n in range(depth))
        tag = Tag(kb_id=kb.id, name="metadata-benchmark", normalized_name="metadata-benchmark")
        db.add(tag)
        db.flush()
        docs = [Document(kb_id=kb.id, owner_id=DEMO_USER_ID, folder_id=f"depth-{depth - 1}", display_name=f"doc-{n:04d}.txt",
            original_filename=f"doc-{n}.txt", mime_type="text/plain", ext="txt", sha256=str(n),
            size_bytes=1, storage_key=f"benchmark/{n}/original") for n in range(count)]
        db.add_all(docs)
        db.flush()
        db.add_all(DocumentTag(kb_id=kb.id, document_id=doc.id, tag_id=tag.id) for doc in docs)
        db.commit()
        kb_id = kb.id
    timings, query_counts = {"descendants_ms": [], "document_page_ms": [], "folder_delete_ms": []}, []
    for _ in range(repeats):
        with factory() as db:
            started = time.perf_counter()
            assert len(descendants(db, kb_id, ["depth-0"])) == depth
            timings["descendants_ms"].append((time.perf_counter() - started) * 1000)
        statements = []

        def observe(_connection, _cursor, statement, _parameters, _context, _many, statements=statements):
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)

        event.listen(engine, "before_cursor_execute", observe)
        try:
            with factory() as db:
                started = time.perf_counter()
                page = documents(kb_id, sort="name", page=1, page_size=count, db=db)
                timings["document_page_ms"].append((time.perf_counter() - started) * 1000)
                assert page["total"] == len(page["items"]) == count
                assert all(len(doc["tag_ids"]) == 1 for doc in page["items"])
        finally:
            event.remove(engine, "before_cursor_execute", observe)
        counts = {"document_page_total": len(statements),
            "document_page_tags": sum("FROM document_tags" in statement for statement in statements)}
        statements.clear()
        event.listen(engine, "before_cursor_execute", observe)
        try:
            with factory() as db:
                started = time.perf_counter()
                assert delete_folder("depth-0", db=db)["folders"] == depth
                db.flush()
                timings["folder_delete_ms"].append((time.perf_counter() - started) * 1000)
                # Roll back the synthetic deletion so each repeat sees identical data.
                db.rollback()
        finally:
            event.remove(engine, "before_cursor_execute", observe)
        counts["folder_delete_total"] = len(statements)
        counts["folder_delete_tags"] = sum("FROM document_tags" in statement for statement in statements)
        query_counts.append(counts)
    engine.dispose()
    return {"backend": "isolated in-memory SQLite", "depth": depth, "documents": count,
        "repeats": repeats, "median_ms": {key: round(statistics.median(values), 3) for key, values in timings.items()},
        "samples_ms": timings, "select_queries": query_counts}


def benchmark_batches(count=200, repeats=5):
    """Optional HTTP batch cases; the original benchmark above is unchanged."""
    from fastapi.testclient import TestClient
    from sqlalchemy import text
    from sqlalchemy.pool import StaticPool

    from app.db.models import AuditLog, utcnow
    from app.db.session import get_db
    from app.main import app

    def make_override(factory):
        def override():
            with factory() as db:
                try:
                    yield db
                    db.commit()
                except Exception:
                    db.rollback()
                    raise
        return override

    results = {}
    for action in ("move", "tags", "trash", "restore"):
        samples, queries = [], []
        for _ in range(repeats):
            engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
            Base.metadata.create_all(engine)
            factory = sessionmaker(engine, expire_on_commit=False)
            with factory() as db:
                db.execute(text("PRAGMA foreign_keys=ON"))
                seed(db)
                kb = db.scalar(select(KnowledgeBase))
                source, target = [Folder(kb_id=kb.id, name=name) for name in ("source", "target")]
                a, b = [Tag(kb_id=kb.id, name=name, normalized_name=name) for name in ("old", "new")]
                db.add_all([source, target, a, b])
                db.flush()
                deleted_at = utcnow() if action == "restore" else None
                docs = [Document(kb_id=kb.id, owner_id=DEMO_USER_ID, folder_id=source.id,
                    display_name=f"doc-{n:04d}.txt", original_filename=f"doc-{n:04d}.txt", ext="txt",
                    mime_type="text/plain", sha256=str(n), size_bytes=1, storage_key=f"batch/{n}/original",
                    deleted_at=deleted_at) for n in range(count)]
                db.add_all(docs)
                db.flush()
                db.add_all(DocumentTag(document_id=doc.id, tag_id=a.id, kb_id=kb.id) for doc in docs)
                db.commit()
                body = {"kb_id": kb.id, "document_ids": [doc.id for doc in docs], "action": action,
                    "folder_id": target.id, "tag_ids": [b.id], "tag_mode": "add"}
            statements = Counter()

            def observe(_conn, _cursor, sql, _parameters, _context, _many, statements=statements):
                statements[sql.lstrip().split()[0].upper()] += 1

            previous_override = app.dependency_overrides.get(get_db)
            app.dependency_overrides[get_db] = make_override(factory)
            try:
                with TestClient(app) as client:
                    event.listen(engine, "before_cursor_execute", observe)
                    try:
                        started = time.perf_counter()
                        response = client.post("/api/documents/batch", json=body)
                        samples.append((time.perf_counter() - started) * 1000)
                    finally:
                        event.remove(engine, "before_cursor_execute", observe)
                    assert response.status_code == 200, response.text
                    assert [doc["id"] for doc in response.json()["items"]] == body["document_ids"]
                    assert all(doc["version"] == 2 for doc in response.json()["items"])
                    with factory() as db:
                        assert len(list(db.scalars(select(AuditLog)))) == count
                queries.append(dict(statements))
            finally:
                if previous_override is None:
                    app.dependency_overrides.pop(get_db, None)
                else:
                    app.dependency_overrides[get_db] = previous_override
                engine.dispose()
        results[action] = {"median_ms": round(statistics.median(samples), 3), "samples_ms": samples, "sql": queries}
    return {"backend": "in-memory SQLite, foreign_keys=ON, TestClient HTTP", "documents": count,
        "repeats": repeats, "actions": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--depth", type=int, default=3000)
    parser.add_argument("--documents", type=int, default=200, choices=range(1, 201), metavar="1..200")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--include-batch", action="store_true", help="Append separate HTTP metadata-batch cases")
    args = parser.parse_args()
    if args.depth < 1 or args.repeats < 1:
        parser.error("depth and repeats must be positive")
    result = run(args.depth, args.documents, args.repeats)
    if args.include_batch:
        result["batch"] = benchmark_batches(args.documents, args.repeats)
    output = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output + "\n", encoding="utf-8")
    print(output)
