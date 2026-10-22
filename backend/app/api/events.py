import asyncio
import json

from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.core.errors import AppError
from app.db.session import SessionLocal


def event_stream(model, foreign_key, resource_id, after=0, terminal=None, session_factory=SessionLocal, authorize=None, transform=None):
    async def generate():
        cursor = max(0, after)
        idle = 0
        while idle < 120:
            with session_factory() as db:
                if authorize:
                    try:
                        authorize(db)
                    except AppError as exc:
                        yield f"event: error\ndata: {json.dumps({'code': exc.code, 'message': '资源已删除或权限发生变化，事件订阅已停止'}, ensure_ascii=False)}\n\n"
                        return
                events = list(db.scalars(select(model).where(foreign_key == resource_id, model.sequence > cursor).order_by(model.sequence).limit(200)))
                for item in events:
                    cursor = item.sequence
                    data = transform(db, item) if transform else item.data
                    payload = {"sequence": cursor, "timestamp": item.created_at.isoformat(), **data}
                    yield f"id: {cursor}\nevent: {item.type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                done = terminal(db) if terminal else False
            if done and not events:
                return
            if not events:
                idle += 1
                yield ": heartbeat\n\n"
            else:
                idle = 0
            await asyncio.sleep(0.5)
    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
