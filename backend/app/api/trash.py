from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import StorageDeletion
from app.db.session import get_db
from app.services.permissions import get_actor
from app.services.storage_cleanup import cleanup_storage
from app.services.trash import list_trash, purge_trash

router = APIRouter(prefix="/api/trash")


class PurgeRequest(BaseModel):
    kind: Literal["document", "folder", "knowledge_base", "all"]
    ids: list[str] = Field(default_factory=list, max_length=200)
    confirm: Literal[True]


@router.get("")
def trash(kind: Literal["document", "folder", "knowledge_base"] = "document", q: str = Query("", max_length=200),
          page: int = Query(1, ge=1), page_size: int = Query(30, ge=1, le=100), db: Session = Depends(get_db, scope="function")):
    return list_trash(db, get_actor(db).id, kind, q, page, page_size)


@router.post("/purge")
def purge(body: PurgeRequest, db: Session = Depends(get_db, scope="function")):
    actor_id = get_actor(db).id
    result = purge_trash(db, actor_id, body.kind, body.ids)
    cleanup_storage(db, get_settings().upload_root, actor_id)
    pending = db.scalar(select(func.count()).select_from(StorageDeletion).where(StorageDeletion.owner_id == actor_id))
    return {"deleted": result, "pending_file_cleanup": pending}
