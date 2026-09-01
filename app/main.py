import asyncio
import re
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import APP_NAME, SESSION_COOKIE_NAME
from app.core.paths import STATIC_DIR
from app.core.security import read_session_token
from app.core.templates import templates
from app.db import create_indexes
from app.db.mongo import ping
from app.routes import (
    admin_routes,
    auth_routes,
    calendar_routes,
    contact_routes,
    event_routes,
    finalize_routes,
    folder_routes,
    page_routes,
    record_routes,
    user_routes,
)
from app.services import access_log_service, event_service
from app.services.auth_service import get_optional_user

app = FastAPI(title=APP_NAME)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_store_api_middleware(request: Request, call_next):
    """API 응답을 브라우저가 캐시하지 못하게 합니다.

    Cache-Control이 없으면 크롬은 나름의 기준으로 GET 응답을 재사용합니다.
    그래서 일정을 만든 뒤 뒤로 가면 대시보드가 **생성 전 목록**을 그대로
    다시 그렸습니다 - 요청은 나갔지만 응답이 캐시에서 나왔기 때문입니다.
    (수동 새로고침을 하면 그제서야 새 일정이 보였습니다.)

    정적 파일은 그대로 둡니다 - 캐시되는 편이 맞고, 이름에 해시가 붙습니다.
    """
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.middleware("http")
async def access_log_middleware(request: Request, call_next):
    """Records one lean row per non-static request for the admin dashboard
    (see access_log_service). Logging happens as a background task so it
    never adds latency to the actual response."""
    path = request.url.path
    if not access_log_service.should_log(path):
        return await call_next(request)

    start = time.monotonic()
    response = await call_next(request)
    duration_ms = (time.monotonic() - start) * 1000

    user_id = read_session_token(request.cookies.get(SESSION_COOKIE_NAME))
    asyncio.create_task(
        access_log_service.record_request(
            method=request.method,
            path=path,
            status_code=response.status_code,
            duration_ms=duration_ms,
            user_id=user_id,
            ip=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    return response


# /api/events/{id}/... 아래의 쓰기 요청. finalize(확정/취소)도 같은 prefix를
# 쓰므로 함께 걸립니다. 일정 생성(POST /api/events)은 id가 없어 걸리지 않는데,
# 아직 아무도 보고 있지 않은 일정이라 올릴 것도 없습니다.
_EVENT_WRITE_PATH = re.compile(r"^/api/events/([^/]+)")


@app.middleware("http")
async def bump_event_version_middleware(request: Request, call_next):
    """쓰기가 성공하면 그 일정의 버전을 올립니다.

    일정 화면이 자동으로 갱신되려면 "언제 바뀌었는지"를 알아야 하는데,
    쓰기 경로가 서른 군데 가까이 흩어져 있어서 한 군데씩 올리면 반드시
    빠뜨립니다. HTTP 계층에서 한 번에 거는 이유입니다 - 새 쓰기 엔드포인트를
    추가해도 자동으로 포함됩니다.

    응답을 돌려주기 **전에** 올립니다. 저장이 성공했다는 응답을 받은 화면이
    곧바로 폴링했을 때 옛 버전을 보는 일이 없어야 하기 때문입니다. 쓰기는
    드물고 인덱스 갱신 한 번이라 지연은 무시할 수준입니다.
    """
    response = await call_next(request)
    if request.method == "GET" or not (200 <= response.status_code < 300):
        return response
    match = _EVENT_WRITE_PATH.match(request.url.path)
    if match:
        await event_service.bump_version(match.group(1))
    return response


# 가용시간 응답은 ISO 문자열 배열이라 반복이 극심합니다 - 압축하면 열 배
# 넘게 줄어듭니다. 화면이 주기적으로 다시 받아 가는 데이터라 효과가 큽니다.
# 마지막에 추가해 가장 바깥에 놓습니다 (Starlette은 나중에 추가한 미들웨어가
# 바깥쪽입니다).
app.add_middleware(GZipMiddleware, minimum_size=1024)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

app.include_router(page_routes.router)
app.include_router(auth_routes.router)
app.include_router(event_routes.router)
app.include_router(finalize_routes.router)
app.include_router(folder_routes.router)
app.include_router(user_routes.router)
app.include_router(user_routes.public_router)
app.include_router(calendar_routes.router)
app.include_router(contact_routes.router)
app.include_router(record_routes.router)
app.include_router(admin_routes.router)


@app.on_event("startup")
async def on_startup() -> None:
    await ping()
    await create_indexes()


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = exc.errors()
    for error in errors:
        error.pop("input", None)
    return JSONResponse(status_code=422, content={"detail": errors})


@app.exception_handler(404)
async def not_found_handler(request: Request, exc: StarletteHTTPException):
    if request.url.path.startswith("/api"):
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    user = await get_optional_user(request)
    return templates.TemplateResponse(
        request=request, name="errors/404.html", context={"user": user}, status_code=404
    )


@app.exception_handler(500)
async def server_error_handler(request: Request, exc: Exception):
    if request.url.path.startswith("/api"):
        return JSONResponse(
            status_code=500, content={"detail": "Internal server error"}
        )
    user = await get_optional_user(request)
    return templates.TemplateResponse(
        request=request, name="errors/500.html", context={"user": user}, status_code=500
    )
