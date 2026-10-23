import ipaddress
import logging
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from app.api.library import router as library_router
from app.api.review import router as review_router
from app.api.trash import router as trash_router
from app.api.workflows import router as workflow_router
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.upload_limit import UploadLimitMiddleware

settings = get_settings()
if settings.app_env not in {"local", "test"}:
    raise RuntimeError("Demo 身份仅允许 APP_ENV=local/test；公开部署必须先实现真实认证")

app = FastAPI(title="知簇 · ZhiCluster", version="0.1.0")
app.add_middleware(UploadLimitMiddleware)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allow_headers=["Content-Type", "Last-Event-ID"], allow_credentials=False)


@app.middleware("http")
async def local_only(request: Request, call_next):
    request.state.request_id = str(uuid4())
    origin = request.headers.get("origin")
    if origin and origin not in settings.cors_origins:
        return JSONResponse(status_code=403, content={"code": "origin_denied", "message": "本地 Demo 不接受此来源", "request_id": request.state.request_id})
    hostname = request.url.hostname or ""
    # Host allowlist also blocks DNS rebinding. Internal reverse proxies retain the browser Host.
    allowed_host = hostname.lower() in {"localhost", "testserver", "api"}
    try:
        allowed_host |= ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        pass
    if not allowed_host:
        return JSONResponse(status_code=403, content={"code": "local_only", "message": "免登录 Demo 仅允许本地访问", "request_id": request.state.request_id})
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.exception_handler(AppError)
async def app_error(request, exc):
    return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": exc.message, "details": exc.details, "request_id": request.state.request_id})


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    # Never echo submitted values (future inputs may contain credentials).
    details = [{"loc": list(error["loc"]), "message": error["msg"]} for error in exc.errors()]
    return JSONResponse(status_code=422, content={"code": "validation_error", "message": "输入格式不正确", "details": details, "request_id": request.state.request_id})


@app.exception_handler(IntegrityError)
async def integrity_error(request, exc):
    return JSONResponse(status_code=409, content={"code": "conflict", "message": "数据冲突，请刷新后重试", "request_id": request.state.request_id})


@app.exception_handler(Exception)
async def unexpected_error(request, exc):
    logging.getLogger(__name__).error("Request %s failed: %s", request.state.request_id, type(exc).__name__)
    return JSONResponse(status_code=500, content={"code": "internal_error", "message": "请求失败，请凭 request_id 查看服务日志", "request_id": request.state.request_id})


app.include_router(library_router)
app.include_router(review_router)
app.include_router(trash_router)
app.include_router(workflow_router)
from app.api.agent import router as agent_router  # noqa: E402

app.include_router(agent_router, prefix="/api")
