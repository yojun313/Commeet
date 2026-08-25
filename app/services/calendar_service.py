"""Google Calendar integration: OAuth connect flow + free/busy reads.

Everything here degrades gracefully when GOOGLE_CLIENT_ID/SECRET aren't
configured (`GoogleCalendarNotConfigured`) - the rest of the app checks
`app.config.GOOGLE_CALENDAR_ENABLED` before offering the "connect" button,
and callers of the functions below should be ready to catch this exception
regardless.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import httpx

from app.config import (
    GOOGLE_CALENDAR_ENABLED,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
)
from app.core.ids import is_object_id, to_object_id
from app.db import users_col

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList"
CALENDARS_URL = "https://www.googleapis.com/calendar/v3/calendars"
CALENDAR_EVENTS_URL = (
    "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"
)
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
COMMEET_CALENDAR_SUMMARY = "Commeet"
# calendar.readonly lists calendars/reads busy times for the availability
# grid; calendar.events lets confirmed Commeet meetings get written as events
# (see sync_meeting_to_account below); calendar.calendars additionally lets
# Commeet create its own dedicated "Commeet" secondary calendar to write those
# events into (see create_commeet_calendar), instead of dumping them into the
# account's primary calendar. Accounts connected before a given scope was
# added only hold a refresh token scoped to the older, narrower consent and
# must reconnect - refreshing a token never grants scopes beyond what was
# originally approved.
SCOPE = (
    "openid email profile "
    "https://www.googleapis.com/auth/calendar.readonly "
    "https://www.googleapis.com/auth/calendar.events "
    "https://www.googleapis.com/auth/calendar.calendars"
)


logger = logging.getLogger("commeet.calendar")

# asyncio only holds a weak reference to a running task, so a fire-and-forget
# task can be garbage collected mid-flight. Keeping the handles here until
# they finish is the documented way to avoid that.
_background_tasks: set[asyncio.Task] = set()


def _spawn_background(coro) -> None:
    async def runner():
        try:
            await coro
        except Exception:
            logger.exception("background calendar task failed")

    task = asyncio.create_task(runner())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


class GoogleCalendarNotConfigured(Exception):
    pass


def _require_configured() -> None:
    if not GOOGLE_CALENDAR_ENABLED:
        raise GoogleCalendarNotConfigured(
            "Google Calendar credentials are not configured on this server"
        )


def account_key(email: str, calendar_type: str = "google") -> str:
    """Composite dict key for `user.calendarAccounts`.

    This string gets embedded directly into MongoDB `$set`/`$unset`
    *operator* keys elsewhere in this module (e.g. `f"calendarAccounts.{key}"`),
    and Mongo always parses those as dot-paths - a literal "." here (which
    every email address has, e.g. "gmail.com") silently splits the document
    into extra nested levels instead of storing a single field. Swapping in
    a fullwidth dot keeps the key human-readable while never colliding with
    Mongo's path syntax.
    """
    safe_email = email.strip().lower().replace(".", "．")
    return f"{safe_email}_{calendar_type}"


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


def _is_real_busy_time_calendar(item: dict) -> bool:
    """Filters `get_calendar_list()` down to calendars worth offering as a
    "read busy times from" toggle. Excludes:
    - calendars the user can't actually edit (accessRole reader/freeBusyReader)
      - covers holiday calendars, which are always read-only subscriptions
    - Google's auto-provisioned "Family" calendar (id always starts with the
      literal "family" prefix) - shared family scheduling, not personal busy time
    - our own auto-created Commeet calendar (see create_commeet_calendar) - it holds
      Commeet's own writes, reading it back as a busy-time source would be a
      pointless feedback loop
    """
    if item.get("accessRole") not in ("owner", "writer"):
        return False
    if item["id"].startswith("family"):
        return False
    return item.get("summary") != COMMEET_CALENDAR_SUMMARY


async def get_calendar_list(access_token: str) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            CALENDAR_LIST_URL,
            params={"fields": "items(id,summary,selected,accessRole)"},
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
        if _is_real_busy_time_calendar(item)
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
    # Fetched before creating the Commeet calendar below, so that calendar
    # doesn't immediately show up as one of its own "read busy times from"
    # toggles in Settings.
    sub_calendars = await get_calendar_list(access_token)

    commeet_calendar_id = None
    try:
        commeet_calendar_id = await create_commeet_calendar(access_token)
    except httpx.HTTPError:
        pass  # best-effort - sync_meeting_to_account() creates it lazily on first sync otherwise

    account = {
        "calendarType": "google",
        "email": email,
        "picture": userinfo.get("picture", ""),
        "enabled": True,
        "subCalendars": sub_calendars,
        "pctsCalendarId": commeet_calendar_id,
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
    account = (user.get("calendarAccounts") or {}).get(key)

    if account and GOOGLE_CALENDAR_ENABLED:
        # The dedicated Commeet calendar this account got on connect (see
        # create_commeet_calendar) is meaningless once the account is
        # disconnected - Commeet won't write to or manage it anymore, so leaving
        # it behind would just be an orphaned "Commeet" calendar with no way to
        # remove it from here again. Best-effort: disconnecting in Commeet must
        # succeed either way.
        try:
            fresh = await _ensure_fresh_account(user, key, account)
            access_token = (fresh.get("oauth") or {}).get("accessToken")
            commeet_calendar_id = fresh.get("pctsCalendarId")
            if access_token and commeet_calendar_id:
                await delete_calendar(access_token, commeet_calendar_id)
        except httpx.HTTPError:
            pass

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
    # Google's own calendar IDs also routinely contain literal dots (e.g.
    # "...@group.calendar.google.com"), so this can't go through an operator
    # dot-path the way toggle_account() does above - that would corrupt the
    # document the exact same way an unsanitized email did in account_key().
    # Read-modify-write the whole account object instead: sub_calendar_id is
    # then just a plain dict key inside a value, never parsed as a path.
    fresh = await users_col.find_one(
        {"_id": user["_id"]}, {f"calendarAccounts.{key}": 1}
    )
    account = ((fresh or {}).get("calendarAccounts") or {}).get(key)
    if not account:
        return
    sub_calendars = account.get("subCalendars") or {}
    if sub_calendar_id not in sub_calendars:
        return
    sub_calendars[sub_calendar_id]["enabled"] = enabled
    account["subCalendars"] = sub_calendars
    await users_col.update_one(
        {"_id": user["_id"]}, {"$set": {f"calendarAccounts.{key}": account}}
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
            if not enabled_calendar_ids and fresh.get("email"):
                # Fall back to the account's own primary calendar (its
                # Google Calendar ID is just its email address). Read the
                # real email field rather than reverse-parsing `key`, since
                # account_key() sanitizes dots out of the key for Mongo's
                # sake and that sanitized form is not a valid calendar ID.
                enabled_calendar_ids = [fresh["email"]]

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


# ---------------------------------------------------------------------------
# Writing confirmed Commeet meetings onto a connected account's own calendar
# ---------------------------------------------------------------------------


async def insert_calendar_event(
    access_token: str,
    calendar_id: str,
    *,
    summary: str,
    description: str,
    start: datetime,
    end: datetime,
) -> str:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            CALENDAR_EVENTS_URL.format(calendar_id=calendar_id),
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "summary": summary,
                "description": description,
                "start": {"dateTime": start.astimezone(UTC).isoformat()},
                "end": {"dateTime": end.astimezone(UTC).isoformat()},
            },
        )
        resp.raise_for_status()
        return resp.json()["id"]


async def create_commeet_calendar(access_token: str) -> str:
    """Creates a dedicated secondary "Commeet" calendar so confirmed meetings
    don't get mixed into the account's primary calendar. Google automatically
    adds a newly-created calendar to its owner's own calendar list (visible,
    selected) - no separate calendarList.insert call is needed for that."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            CALENDARS_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "summary": COMMEET_CALENDAR_SUMMARY,
                "description": "POSTECH CSE Time Scheduler에서 확정된 약속이 자동으로 추가되는 캘린더입니다.",
            },
        )
        resp.raise_for_status()
        return resp.json()["id"]


async def delete_calendar(access_token: str, calendar_id: str) -> None:
    """Deletes a whole calendar (e.g. the dedicated Commeet calendar) - not just
    one event in it. Deleting it also removes every event inside it, so this
    is the one call needed on disconnect rather than clearing events first."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(
            f"{CALENDARS_URL}/{calendar_id}",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if resp.status_code not in (204, 404, 410):
            resp.raise_for_status()


async def delete_calendar_event(
    access_token: str, calendar_id: str, google_event_id: str
) -> None:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(
            f"{CALENDAR_EVENTS_URL.format(calendar_id=calendar_id)}/{google_event_id}",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        # 404/410 just means it's already gone (e.g. the user deleted it by
        # hand) - nothing left to clean up, not a failure.
        if resp.status_code not in (204, 404, 410):
            resp.raise_for_status()


async def sync_meeting_to_account(
    user: dict, *, summary: str, description: str, start: datetime, end: datetime
) -> dict | None:
    """Writes one event to every enabled Google account connected to `user`.

    Best-effort and silent: a confirmed Commeet schedule is authoritative on its
    own, Google Calendar is just a convenience mirror, so a sync failure
    (no connected account, an account still scoped read-only from before
    this feature shipped, a transient API error) must never block or fail
    the confirm/cancel flow that calls this.
    """
    if not GOOGLE_CALENDAR_ENABLED:
        return None

    accounts = user.get("calendarAccounts") or {}
    for key, account in accounts.items():
        if account.get("calendarType") != "google" or not account.get("enabled", True):
            continue
        try:
            fresh = await _ensure_fresh_account(user, key, account)
            access_token = (fresh.get("oauth") or {}).get("accessToken")
            if not access_token:
                continue

            calendar_id = fresh.get("pctsCalendarId")
            if not calendar_id:
                # Account connected before the dedicated Commeet calendar
                # existed (connect_account() creates it eagerly now) -
                # create it now instead and remember it for next time.
                calendar_id = await create_commeet_calendar(access_token)
                await users_col.update_one(
                    {"_id": user["_id"]},
                    {"$set": {f"calendarAccounts.{key}.pctsCalendarId": calendar_id}},
                )

            google_event_id = await insert_calendar_event(
                access_token,
                calendar_id,
                summary=summary,
                description=description,
                start=start,
                end=end,
            )
            return {
                "accountKey": key,
                "calendarId": calendar_id,
                "googleEventId": google_event_id,
            }
        except httpx.HTTPError:
            continue
    return None


async def remove_synced_event(
    user: dict, calendar_id: str, google_event_id: str
) -> None:
    if not GOOGLE_CALENDAR_ENABLED:
        return
    accounts = user.get("calendarAccounts") or {}
    for key, account in accounts.items():
        # A synced event's calendar_id is either the account's own primary
        # calendar (its email) or its dedicated Commeet calendar - match either,
        # since sync_meeting_to_account() now prefers the latter.
        if calendar_id not in (account.get("email"), account.get("pctsCalendarId")):
            continue
        try:
            fresh = await _ensure_fresh_account(user, key, account)
            access_token = (fresh.get("oauth") or {}).get("accessToken")
            if access_token:
                await delete_calendar_event(access_token, calendar_id, google_event_id)
        except httpx.HTTPError:
            pass
        return


def partition_synced_events(
    records: list[dict] | None, *, only_future: bool = False
) -> tuple[list[dict], list[dict]]:
    """Splits sync records (each `{"userId", "calendarId", "googleEventId",
    "start", "end"}`, as produced by sync_meeting_to_account) into
    (to_remove, kept). Pure - no I/O - so callers can decide what to persist
    without waiting on Google.

    With `only_future=True` (used when an event/room is deleted), a record
    whose meeting already happened is kept: the meeting is real history at
    that point, and there's no reason to erase it from someone's calendar
    just because the Commeet room got deleted afterwards. A record with no
    stored `start` (synced before that field existed) is kept too,
    conservatively. Without `only_future` (confirm()/cancel() replacing or
    voiding the whole schedule), everything is removed.
    """
    to_remove: list[dict] = []
    kept: list[dict] = []
    now = datetime.now(UTC)
    for rec in records or []:
        start = rec.get("start")
        if only_future and (not isinstance(start, datetime) or start <= now):
            kept.append(rec)
        else:
            to_remove.append(rec)
    return to_remove, kept


async def _delete_synced_records(records: list[dict]) -> None:
    """Deletes the given sync records from Google.

    Grouped by owner so each user document is loaded and each access token
    refreshed once, then deleted one at a time. Sequential on purpose:
    firing a few dozen deletes at once gets some of them dropped by Google's
    rate limiter, and since this runs detached from the request (see
    clear_synced_events_detached) nothing is waiting on it anyway. A single
    retry covers the occasional transient failure.
    """
    by_user: dict[str, list[dict]] = {}
    for rec in records:
        by_user.setdefault(rec.get("userId", ""), []).append(rec)

    for user_id, recs in by_user.items():
        oid = to_object_id(user_id)
        if oid is None:
            continue
        user_doc = await users_col.find_one({"_id": oid})
        if not user_doc:
            continue

        for rec in recs:
            calendar_id = rec["calendarId"]
            event_id = rec["googleEventId"]
            account = _match_account(user_doc, calendar_id)
            if not account:
                continue
            key, acc = account
            try:
                fresh = await _ensure_fresh_account(user_doc, key, acc)
                token = (fresh.get("oauth") or {}).get("accessToken")
                if not token:
                    continue
                await delete_calendar_event(token, calendar_id, event_id)
            except httpx.HTTPError:
                try:
                    await asyncio.sleep(1)
                    await delete_calendar_event(token, calendar_id, event_id)
                except httpx.HTTPError:
                    logger.warning(
                        "could not delete Google event %s from %s", event_id, calendar_id
                    )


def _match_account(user: dict, calendar_id: str):
    """The (key, account) whose primary or Commeet calendar this id belongs to."""
    for key, account in (user.get("calendarAccounts") or {}).items():
        if calendar_id in (account.get("email"), account.get("pctsCalendarId")):
            return key, account
    return None


async def clear_synced_events(
    records: list[dict] | None, *, only_future: bool = False
) -> list[dict]:
    """Awaits the Google deletions and returns the records that were kept."""
    to_remove, kept = partition_synced_events(records, only_future=only_future)
    await _delete_synced_records(to_remove)
    return kept


def clear_synced_events_detached(
    records: list[dict] | None, *, only_future: bool = False
) -> list[dict]:
    """Same as `clear_synced_events`, but the Google calls run detached and
    the kept records come back straight away.

    Deleting an event shouldn't sit there while a few dozen Google API round
    trips finish - Commeet's own database is the source of truth, and the
    calendar mirror catching up a moment later is harmless. Failures are
    logged by the task itself rather than surfaced, for the same reason
    sync_meeting_to_account() is best-effort.
    """
    to_remove, kept = partition_synced_events(records, only_future=only_future)
    if to_remove:
        _spawn_background(_delete_synced_records(to_remove))
    return kept


async def find_linked_user(key: str) -> dict | None:
    """Resolves a finalize_service participant `key` back to its Commeet user
    doc, if it is one (registered users' keys are their ObjectId hex string;
    guest keys are just the guest's literal name and never match)."""
    if not is_object_id(key):
        return None
    return await users_col.find_one({"_id": to_object_id(key)})
