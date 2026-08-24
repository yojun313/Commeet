"""Google Calendar integration: OAuth connect flow + free/busy reads.

Everything here degrades gracefully when GOOGLE_CLIENT_ID/SECRET aren't
configured (`GoogleCalendarNotConfigured`) - the rest of the app checks
`app.config.GOOGLE_CALENDAR_ENABLED` before offering the "connect" button,
and callers of the functions below should be ready to catch this exception
regardless.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import httpx

from app.config import (
    GOOGLE_CALENDAR_ENABLED,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
)
from app.db import users_col

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList"
CALENDAR_EVENTS_URL = (
    "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"
)
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
SCOPE = "openid email profile https://www.googleapis.com/auth/calendar.readonly"


class GoogleCalendarNotConfigured(Exception):
    pass


def _require_configured() -> None:
    if not GOOGLE_CALENDAR_ENABLED:
        raise GoogleCalendarNotConfigured(
            "Google Calendar credentials are not configured on this server"
        )


def account_key(email: str, calendar_type: str = "google") -> str:
    return f"{email.strip().lower()}_{calendar_type}"


def build_authorize_url(state: str) -> str:
    _require_configured()
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


async def exchange_code_for_tokens(code: str) -> dict:
    _require_configured()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "code": code,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def refresh_access_token(refresh_token: str) -> dict:
    _require_configured()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def get_userinfo(access_token: str) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}
        )
        resp.raise_for_status()
        return resp.json()


async def get_calendar_list(access_token: str) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            CALENDAR_LIST_URL,
            params={"fields": "items(id,summary,selected)"},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
    return {
        item["id"]: {
            "name": item.get("summary", item["id"]),
            "enabled": bool(item.get("selected")),
        }
        for item in items
    }


async def get_calendar_events(
    access_token: str, calendar_id: str, time_min: datetime, time_max: datetime
) -> list[dict]:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            CALENDAR_EVENTS_URL.format(calendar_id=calendar_id),
            params={
                "timeMin": time_min.astimezone(UTC).isoformat(),
                "timeMax": time_max.astimezone(UTC).isoformat(),
                "singleEvents": "true",
                "fields": "items(id,summary,start,end,transparency,attendees)",
            },
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])

    events = []
    for item in items:
        start = item.get("start", {})
        end = item.get("end", {})
        all_day = "date" in start
        if all_day:
            start_dt = datetime.fromisoformat(start["date"]).replace(tzinfo=UTC)
            end_dt = datetime.fromisoformat(end["date"]).replace(tzinfo=UTC)
        else:
            start_dt = datetime.fromisoformat(start["dateTime"])
            end_dt = datetime.fromisoformat(end["dateTime"])

        free = item.get("transparency") == "transparent"
        if not free:
            for attendee in item.get("attendees", []) or []:
                if attendee.get("self") and attendee.get("responseStatus") not in (
                    "accepted",
                    None,
                ):
                    free = True
                    break

        events.append(
            {
                "id": item.get("id", ""),
                "calendarId": calendar_id,
                "summary": item.get("summary", "(제목 없음)"),
                "startDate": start_dt,
                "endDate": end_dt,
                "free": free,
                "allDay": all_day,
            }
        )
    return events


async def _ensure_fresh_account(
    user: dict, account_key_str: str, account: dict
) -> dict:
    """Refreshes the account's access token if expired, persisting the new
    token onto the user document. Returns the (possibly updated) account dict."""
    oauth = account.get("oauth") or {}
    expire_at = oauth.get("accessTokenExpireDate")
    now = datetime.now(UTC)
    if expire_at and expire_at > now + timedelta(seconds=30):
        return account

    refresh_token = oauth.get("refreshToken")
    if not refresh_token:
        return account

    try:
        tokens = await refresh_access_token(refresh_token)
    except httpx.HTTPError:
        return account

    oauth["accessToken"] = tokens["access_token"]
    oauth["accessTokenExpireDate"] = now + timedelta(
        seconds=tokens.get("expires_in", 3600)
    )
    account["oauth"] = oauth

    await users_col.update_one(
        {"_id": user["_id"]},
        {"$set": {f"calendarAccounts.{account_key_str}.oauth": oauth}},
    )
    return account


async def connect_account(user: dict, tokens: dict) -> dict:
    """Stores a newly-authorized Google account on the user doc and returns it."""
    access_token = tokens["access_token"]
    userinfo = await get_userinfo(access_token)
    email = (userinfo.get("email") or "").strip().lower()
    key = account_key(email)

    now = datetime.now(UTC)
    sub_calendars = await get_calendar_list(access_token)

    account = {
        "calendarType": "google",
        "email": email,
        "picture": userinfo.get("picture", ""),
        "enabled": True,
        "subCalendars": sub_calendars,
        "oauth": {
            "accessToken": access_token,
            "accessTokenExpireDate": now
            + timedelta(seconds=tokens.get("expires_in", 3600)),
            "refreshToken": tokens.get("refresh_token", ""),
            "scope": tokens.get("scope", ""),
        },
    }

    await users_col.update_one(
        {"_id": user["_id"]}, {"$set": {f"calendarAccounts.{key}": account}}
    )
    return account


async def disconnect_account(user: dict, email: str) -> None:
    key = account_key(email)
    await users_col.update_one(
        {"_id": user["_id"]}, {"$unset": {f"calendarAccounts.{key}": ""}}
    )


async def toggle_account(user: dict, email: str, enabled: bool) -> None:
    key = account_key(email)
    await users_col.update_one(
        {"_id": user["_id"]}, {"$set": {f"calendarAccounts.{key}.enabled": enabled}}
    )


async def toggle_sub_calendar(
    user: dict, email: str, sub_calendar_id: str, enabled: bool
) -> None:
    key = account_key(email)
    await users_col.update_one(
        {"_id": user["_id"]},
        {
            "$set": {
                f"calendarAccounts.{key}.subCalendars.{sub_calendar_id}.enabled": enabled
            }
        },
    )


async def get_users_calendar_events(
    user: dict,
    time_min: datetime,
    time_max: datetime,
    account_keys_filter: set[str] | None = None,
) -> dict:
    """Returns {accountKey: {"calendarEvents": [...], "error": str | None}}."""
    if not GOOGLE_CALENDAR_ENABLED:
        return {}

    accounts = user.get("calendarAccounts") or {}
    results: dict[str, dict] = {}

    async def _fetch_account(key: str, account: dict) -> None:
        if not account.get("enabled", True):
            return
        try:
            fresh = await _ensure_fresh_account(user, key, account)
            access_token = (fresh.get("oauth") or {}).get("accessToken")
            if not access_token:
                results[key] = {"calendarEvents": [], "error": "not connected"}
                return

            sub_calendars = fresh.get("subCalendars") or {}
            enabled_calendar_ids = [
                cid for cid, sc in sub_calendars.items() if sc.get("enabled")
            ]
            if not enabled_calendar_ids:
                enabled_calendar_ids = [
                    key.rsplit("_", 1)[0]
                ]  # fall back to primary calendar (their email)

            per_cal = await asyncio.gather(
                *[
                    get_calendar_events(access_token, cid, time_min, time_max)
                    for cid in enabled_calendar_ids
                ],
                return_exceptions=True,
            )
            events: list[dict] = []
            for cal_events in per_cal:
                if isinstance(cal_events, Exception):
                    continue
                events.extend(cal_events)
            results[key] = {"calendarEvents": events, "error": None}
        except Exception as exc:  # noqa: BLE001 - surface as a per-account error, don't fail the whole request
            results[key] = {"calendarEvents": [], "error": str(exc)}

    tasks = []
    for key, account in accounts.items():
        if account_keys_filter and key not in account_keys_filter:
            continue
        tasks.append(_fetch_account(key, account))
    await asyncio.gather(*tasks)

    return results
