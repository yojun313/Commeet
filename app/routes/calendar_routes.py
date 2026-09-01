import secrets
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from app.config import BASE_URL, GOOGLE_CALENDAR_ENABLED
from app.core.serialize import jsonable
from app.services import calendar_service
from app.services.auth_service import require_user

router = APIRouter(tags=["calendar"])

STATE_COOKIE = "google_oauth_state"


def _require_enabled() -> None:
    """연동이 꺼져 있으면 어떤 경로로도 동작하지 않게 합니다.

    UI에서 감추는 것만으로는 부족합니다 - 주소를 직접 치거나 예전 링크를
    눌러 들어올 수 있고, 그때 반쯤 동작하면 상태가 어긋납니다.
    """
    if not GOOGLE_CALENDAR_ENABLED:
        raise HTTPException(
            status_code=501,
            detail="이 서버는 Google Calendar 연동을 사용하지 않습니다.",
        )


@router.get("/calendar/google/connect")
async def google_connect(request: Request):
    await require_user(request)
    _require_enabled()

    state = secrets.token_urlsafe(24)
    response = RedirectResponse(calendar_service.build_authorize_url(state))
    response.set_cookie(STATE_COOKIE, state, max_age=600, httponly=True, samesite="lax")
    return response


@router.get("/calendar/google/callback")
async def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    user = await require_user(request)
    _require_enabled()
    expected_state = request.cookies.get(STATE_COOKIE)
    failure = RedirectResponse(f"{BASE_URL}/calendar?calendar_error=1")

    if error or not code or not state or state != expected_state:
        return failure

    try:
        tokens = await calendar_service.exchange_code_for_tokens(code)
        await calendar_service.connect_account(user, tokens)
    except Exception:
        return failure

    response = RedirectResponse(f"{BASE_URL}/calendar?calendar_connected=1")
    response.delete_cookie(STATE_COOKIE)
    return response


@router.delete("/api/user/calendar-accounts")
async def remove_calendar_account(email: str, request: Request):
    user = await require_user(request)
    _require_enabled()
    await calendar_service.disconnect_account(user, email)
    return {}


@router.post("/api/user/calendar-accounts/toggle")
async def toggle_calendar_account(email: str, enabled: bool, request: Request):
    user = await require_user(request)
    _require_enabled()
    await calendar_service.toggle_account(user, email, enabled)
    return {}


@router.post("/api/user/calendar-accounts/toggle-sub-calendar")
async def toggle_sub_calendar(
    email: str, subCalendarId: str, enabled: bool, request: Request
):
    user = await require_user(request)
    _require_enabled()
    await calendar_service.toggle_sub_calendar(user, email, subCalendarId, enabled)
    return {}


@router.get("/api/user/calendars")
async def get_my_calendars(timeMin: datetime, timeMax: datetime, request: Request):
    user = await require_user(request)
    _require_enabled()
    events = await calendar_service.get_users_calendar_events(user, timeMin, timeMax)
    return jsonable(events)
