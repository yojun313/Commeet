from fastapi.templating import Jinja2Templates

from app.config import (
    ALLOWED_EMAIL_DOMAIN,
    APP_FULL_NAME,
    APP_NAME,
    GOOGLE_CALENDAR_ENABLED,
    PROFESSOR_EMAIL,
    RESTRICT_SIGNUP_DOMAIN,
    SUPPORT_EMAIL,
)
from app.core.paths import STATIC_DIR, TEMPLATES_DIR
from app.core.redirects import sign_in_url, sign_up_url


def asset(path: str) -> str:
    """URL for a static file, stamped with the file's mtime.

    Editing a CSS/JS file changes the URL, so browsers fetch the new version
    instead of serving a stale copy from cache. StaticFiles sends no
    Cache-Control header, which lets browsers cache heuristically and skip
    revalidation entirely - without this stamp a code change can go unseen
    until a hard refresh.
    """
    file_path = STATIC_DIR / path.lstrip("/")
    try:
        version = int(file_path.stat().st_mtime)
    except OSError:
        version = 0
    return f"/static/{path.lstrip('/')}?v={version}"


templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
templates.env.globals["APP_NAME"] = APP_NAME
templates.env.globals["APP_FULL_NAME"] = APP_FULL_NAME
templates.env.globals["GOOGLE_CALENDAR_ENABLED"] = GOOGLE_CALENDAR_ENABLED
templates.env.globals["ALLOWED_EMAIL_DOMAIN"] = ALLOWED_EMAIL_DOMAIN
templates.env.globals["RESTRICT_SIGNUP_DOMAIN"] = RESTRICT_SIGNUP_DOMAIN
templates.env.globals["SUPPORT_EMAIL"] = SUPPORT_EMAIL
templates.env.globals["PROFESSOR_EMAIL"] = PROFESSOR_EMAIL
templates.env.globals["asset"] = asset
# 헤더의 로그인/시작하기 버튼이 "보던 페이지"로 돌아오게 하려면 필요합니다.
templates.env.globals["sign_in_url"] = sign_in_url
templates.env.globals["sign_up_url"] = sign_up_url
