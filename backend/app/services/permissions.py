from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import KnowledgeBase, KnowledgeBaseMember, User

DEMO_USER_ID = "00000000-0000-4000-8000-000000000001"


def get_actor(db: Session) -> User:
    actor = db.get(User, DEMO_USER_ID)
    if not actor:
        raise AppError("not_initialized", "请先运行数据库迁移和初始化", 503)
    return actor


def assert_role(db: Session, actor: User, kb_id: str, roles: set[str], include_deleted=False):
    kb = db.get(KnowledgeBase, kb_id)
    if not kb or (kb.deleted_at and not include_deleted):
        raise AppError("not_found", "知识库不存在或已删除", 404)
    member = db.scalar(select(KnowledgeBaseMember).where(KnowledgeBaseMember.kb_id == kb_id, KnowledgeBaseMember.user_id == actor.id))
    if not member or member.role not in roles:
        raise AppError("forbidden", "没有访问此知识库的权限", 403)
    return kb


def assert_can_read_kb(db, actor, kb_id, include_deleted=False):
    return assert_role(db, actor, kb_id, {"owner", "editor", "viewer"}, include_deleted)


def assert_can_edit_kb(db, actor, kb_id, include_deleted=False):
    return assert_role(db, actor, kb_id, {"owner", "editor"}, include_deleted)


def assert_can_manage_kb(db, actor, kb_id, include_deleted=False):
    return assert_role(db, actor, kb_id, {"owner"}, include_deleted)


def accessible_kb_ids(db, actor):
    return list(db.scalars(select(KnowledgeBase.id).join(KnowledgeBaseMember, KnowledgeBaseMember.kb_id == KnowledgeBase.id).where(KnowledgeBaseMember.user_id == actor.id, KnowledgeBase.deleted_at.is_(None))))
