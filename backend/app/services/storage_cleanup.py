from pathlib import Path

from sqlalchemy import select

from app.db.models import StorageDeletion


def cleanup_storage(db, upload_root: Path, owner_id: str, limit: int = 64) -> int:
    """Clean only an owner's explicitly confirmed deletions, in a bounded batch."""
    root = Path(upload_root).resolve()
    rows = list(db.scalars(select(StorageDeletion).where(StorageDeletion.owner_id == owner_id).order_by(StorageDeletion.updated_at).limit(limit).with_for_update(skip_locked=True)))
    removed = 0
    for row in rows:
        try:
            key = Path(row.storage_key)
            if key.is_absolute() or len(key.parts) != 3 or key.name != "original" or ".." in key.parts:
                raise ValueError("invalid storage path")
            path = root / key
            if any(parent.is_symlink() or getattr(parent, "is_junction", lambda: False)() for parent in (path.parent, path.parent.parent)):
                raise ValueError("linked storage directory")
            if not path.parent.resolve().is_relative_to(root):
                raise ValueError("invalid storage directory")
            # Unlink the exact source file only. Never recursively follow a
            # directory supplied by metadata. Unlink a leaf symlink itself;
            # resolving it first could remove another document's real source.
            path.unlink(missing_ok=True)
            for parent in (path.parent, path.parent.parent):
                if parent != root and parent.is_relative_to(root):
                    try:
                        parent.rmdir()
                    except OSError:
                        pass
            db.delete(row)
            removed += 1
        except (OSError, ValueError):
            row.attempts += 1
            row.error = "原文件清理暂未完成，可再次确认清空以重试"
    db.commit()
    return removed
