import asyncio
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
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
    user_routes,
)
from app.services import access_log_service
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
