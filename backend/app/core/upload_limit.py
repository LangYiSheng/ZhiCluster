from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core.errors import AppError


class UploadLimitMiddleware:
    """Bound multipart bytes before Starlette spools uploads onto local disk."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").endswith("/uploads"):
            return await self.app(scope, receive, send)
        limit = get_settings().max_upload_batch_mb * 1024 * 1024 + 1024 * 1024
        headers = dict(scope.get("headers", []))
        length = headers.get(b"content-length", b"0")
        if not length.isdigit() or int(length) > limit:
            response = JSONResponse(status_code=413, content={"code": "upload_too_large", "message": "上传批次超过总量限制", "request_id": scope.get("state", {}).get("request_id")})
            return await response(scope, receive, send)
        total = 0

        async def bounded_receive():
            nonlocal total
            message = await receive()
            total += len(message.get("body", b""))
            if total > limit:
                raise AppError("upload_too_large", "上传批次超过总量限制", 413)
            return message

        return await self.app(scope, bounded_receive, send)
