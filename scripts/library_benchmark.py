"""Repeatable synthetic metadata benchmark. Never connects to the configured DB."""

import argparse
import json
import os
import statistics
import sys
import time
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--depth", type=int, default=3000)
    parser.add_argument("--documents", type=int, default=200, choices=range(1, 201), metavar="1..200")
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    if args.depth < 1 or args.repeats < 1:
        parser.error("depth and repeats must be positive")
    result = run(args.depth, args.documents, args.repeats)
    output = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output + "\n", encoding="utf-8")
    print(output)
