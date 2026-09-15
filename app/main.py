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

from app.config import APP_NAME, COOKIE_SECURE, SESSION_COOKIE_NAME
from app.core.clientip import get_client_ip
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
    extension_routes,
    finalize_routes,
    folder_routes,
    page_routes,
    record_routes,
    user_routes,
)
from app.services import access_log_service, event_service
from app.services.auth_service import get_optional_user

# API 문서(/docs, /redoc)와 스키마(/openapi.json)는 노출하지 않습니다 -
# 운영 서비스라 엔드포인트 목록 자체가 정찰 자료가 됩니다.
app = FastAPI(title=APP_NAME, docs_url=None, redoc_url=None, openapi_url=None)

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
async def security_headers_middleware(request: Request, call_next):
    """모든 응답에 붙는 보안 헤더.

    - CSP: 외부 출처의 스크립트/스타일을 차단합니다. 이 앱은 CDN 없이 전부
      self-host라 잃는 것이 없고, XSS가 생겨도 외부 코드 로드와 데이터 반출
      경로가 막힙니다. 템플릿에 인라인 <script>가 있어 'unsafe-inline'은
      허용합니다 - 걷어내려면 모든 인라인 스크립트를 파일로 빼야 합니다.
    - frame-ancestors/X-Frame-Options: 다른 사이트가 이 앱을 iframe에 넣어
      클릭을 가로채는 것(클릭재킹)을 막습니다. 앱 자신도 iframe을 안 씁니다.
    - HSTS는 운영(https)에서만 - http 로컬 개발에 붙이면 브라우저가
      localhost를 https로 강제해 개발이 멈춥니다.
    """
    response = await call_next(request)
    h = response.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    h.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "font-src 'self' data:; connect-src 'self'; object-src 'none'; "
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    )
    if COOKIE_SECURE:
        h.setdefault("Strict-Transport-Security", "max-age=31536000")
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
            # nginx 뒤에서는 client.host가 늘 127.0.0.1 - 실제 주소로 기록
            ip=get_client_ip(request) or None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    return response


# /api/events/{id}/... 아래의 쓰기 요청. finalize(확정/취소)도 같은 prefix를
# 쓰므로 함께 걸립니다. 일정 생성(POST /api/events)은 id가 없어 걸리지 않는데,
# 아직 아무도 보고 있지 않은 일정이라 올릴 것도 없습니다.
_EVENT_WRITE_PATH = re.compile(r"^/api/events/([^/]+)")

# 쓰기처럼 보이지만 **아무것도 바꾸지 않는** 요청들. POST인 이유는 본문을
# 받아야 해서일 뿐입니다 - proposal은 최적 배정을 계산해 돌려주기만 하고,
# invite는 메일만 보냅니다 (둘 다 DB에 쓰지 않습니다).
#
# 걸러 내지 않으면 확정 화면이 **자기 자신의 행동**을 남의 변경으로 착각합니다.
# 이미 확정된 일정은 열자마자 proposal을 한 번 돌리는데(finalize.js), 그때
# 올라간 버전 때문에 몇 초 뒤 "참가자의 응답이 바뀌었습니다"가 떴습니다 -
# 아무도 아무것도 바꾸지 않았는데도.
_NO_CHANGE_SUFFIXES = ("/finalize/proposal", "/invite")


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
    if request.url.path.endswith(_NO_CHANGE_SUFFIXES):
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
app.include_router(extension_routes.router)
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
