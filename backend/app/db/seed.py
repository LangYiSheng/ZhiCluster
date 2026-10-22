from sqlalchemy import select

from app.db.models import KnowledgeBase, KnowledgeBaseMember, User
from app.db.session import SessionLocal
from app.services.permissions import DEMO_USER_ID


def seed(db):
    actor = db.get(User, DEMO_USER_ID)
    if not actor:
        actor = User(id=DEMO_USER_ID, email="demo@localhost", display_name="本地用户")
        db.add(actor)
        db.flush()
    if not db.scalar(select(KnowledgeBase).where(KnowledgeBase.owner_id == actor.id)):
        kb = KnowledgeBase(owner_id=actor.id, name="我的知识库", description="让知识在这里连接起来")
        db.add(kb)
        db.flush()
        db.add(KnowledgeBaseMember(kb_id=kb.id, user_id=actor.id, role="owner"))
    db.commit()


if __name__ == "__main__":
    with SessionLocal() as db:
        seed(db)
