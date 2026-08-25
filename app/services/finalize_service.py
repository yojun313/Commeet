"""Closing an event and confirming the final meeting schedule.

The host picks how many people meet at once (1 for one-on-ones), the
optimizer in `scheduling.py` proposes an assignment, the host adjusts it by
hand, and confirming locks the event and emails everyone involved.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from itertools import pairwise

from app.config import APP_NAME, BASE_URL
from app.db import event_responses_col, events_col, users_col
from app.services import calendar_service, email_service
from app.services.scheduling import assign_participants, build_slots, covers_slot


class EventNotClosable(Exception):
    pass


class InvalidMeetingLength(Exception):
    pass


class InvalidMeeting(Exception):
    pass


def is_confirmed(event: dict) -> bool:
    return bool((event.get("finalization") or {}).get("status") == "confirmed")


def _increment(event: dict) -> int:
    return int(event.get("timeIncrement") or 15)


def validate_meeting_minutes(event: dict, meeting_minutes: int) -> None:
    """Blocks must line up with the availability grid to be checkable."""
    increment = _increment(event)
    if meeting_minutes <= 0 or meeting_minutes % increment != 0:
        raise InvalidMeetingLength(f"약속 길이는 {increment}분 단위여야 합니다.")
    window_minutes = float(event.get("duration") or 0) * 60
    if meeting_minutes > window_minutes:
        raise InvalidMeetingLength("약속 길이가 일정의 시간 범위보다 깁니다.")


async def _load_people(event: dict) -> tuple[dict | None, list[dict]]:
    """Returns (host response doc, participant descriptors).

    A participant descriptor is {key, name, email, availability, ifNeeded}.
    """
    responses = await event_responses_col.find({"eventId": event["_id"]}).to_list(
        length=None
    )
    owner_id = event.get("ownerId")
    host_key = str(owner_id) if owner_id else None

    host_response = None
    participants: list[dict] = []

    for doc in responses:
        key = doc["userId"]
        resp = doc.get("response") or {}
        if host_key and key == host_key:
            host_response = resp
            continue

        name = resp.get("name") or ""
        email = resp.get("email") or ""
        if resp.get("userId"):
            user = await users_col.find_one(
                {"_id": resp["userId"]}, {"name": 1, "email": 1}
            )
            if user:
                name = user.get("name") or name
                email = user.get("email") or email

        participants.append(
            {
                "key": key,
                "name": name or key,
                "email": email,
                "availability": set(resp.get("availability") or []),
                "ifNeeded": set(resp.get("ifNeeded") or []),
            }
        )

    participants.sort(key=lambda p: p["name"])
    return host_response, participants


async def build_proposal(
    event: dict, capacity: int, meeting_minutes: int, allow_if_needed: bool
) -> dict:
    """Runs the optimizer and returns a schedule the host can edit."""
    validate_meeting_minutes(event, meeting_minutes)

    increment = _increment(event)
    all_slots = build_slots(
        event.get("dates") or [], float(event.get("duration") or 0), meeting_minutes
    )
    host_response, participants = await _load_people(event)

    # The host attends every meeting, so drop blocks they cannot make.
    if host_response:
        host_ticks = set(host_response.get("availability") or [])
        if allow_if_needed:
            host_ticks |= set(host_response.get("ifNeeded") or [])
        usable = [
            s for s in all_slots if covers_slot(host_ticks, s[0], s[1], increment)
        ]
    else:
        usable = all_slots

    keys = [p["key"] for p in participants]
    available: dict[str, set[int]] = {}
    if_needed: dict[str, set[int]] = {}
    for p in participants:
        firm, soft = set(), set()
        for index, (start, end) in enumerate(usable):
            if covers_slot(p["availability"], start, end, increment):
                firm.add(index)
            elif allow_if_needed and covers_slot(
                p["availability"] | p["ifNeeded"], start, end, increment
            ):
                soft.add(index)
        available[p["key"]] = firm
        if_needed[p["key"]] = soft

    assignment, unassigned = assign_participants(
        keys, usable, available, if_needed, capacity
    )

    by_key = {p["key"]: p for p in participants}
    meetings = []
    for index in sorted(assignment):
        start, end = usable[index]
        meetings.append(
            {
                "start": start,
                "end": end,
                "participants": [
                    {"key": k, "name": by_key[k]["name"]} for k in assignment[index]
                ],
            }
        )

    return {
        "capacity": capacity,
        "meetingMinutes": meeting_minutes,
        "allowIfNeeded": allow_if_needed,
        "meetings": meetings,
        "unassigned": [{"key": k, "name": by_key[k]["name"]} for k in unassigned],
        "slots": [
            {
                "start": start,
                "end": end,
                "eligible": sorted(
                    (
                        p["key"]
                        for p in participants
                        if index in available[p["key"]] or index in if_needed[p["key"]]
                    ),
                ),
            }
            for index, (start, end) in enumerate(usable)
        ],
        "participants": [
            {"key": p["key"], "name": p["name"], "hasEmail": bool(p["email"])}
            for p in participants
        ],
    }


async def _sync_to_google_calendar(
    event: dict, host: dict, finalization: dict, by_key: dict
) -> list[dict]:
    """Best-effort mirror of the confirmed schedule onto Google Calendar for
    the host (who attends every meeting) and each participant who has a
    connected account. Never raises - see sync_meeting_to_account's docstring."""
    if not calendar_service.GOOGLE_CALENDAR_ENABLED:
        return []

    event_url = f"{BASE_URL}/e/{event.get('shortId') or event['_id']}"
    records: list[dict] = []

    async def push(user_doc: dict, meeting: dict, with_whom: str) -> None:
        record = await calendar_service.sync_meeting_to_account(
            user_doc,
            summary=f"[{APP_NAME}] {event.get('name') or '약속'} - {with_whom}",
            description=f"{APP_NAME}에서 확정된 약속입니다.\n{event_url}",
            start=meeting["start"],
            end=meeting["end"],
        )
        if record:
            record["userId"] = str(user_doc["_id"])
            # Kept so a later cleanup (event deletion) can tell whether this
            # meeting has already happened - see calendar_service.clear_synced_events.
            record["start"] = meeting["start"]
            record["end"] = meeting["end"]
            records.append(record)

    tasks = []
    for meeting in finalization["meetings"]:
        names = [by_key[k]["name"] for k in meeting["participants"] if k in by_key]
        tasks.append(push(host, meeting, ", ".join(names) or "참가자"))

        for key in meeting["participants"]:
            person = by_key.get(key)
            if not person:
                continue
            user_doc = await calendar_service.find_linked_user(key)
            if not user_doc or user_doc["_id"] == host["_id"]:
                continue  # already synced above - the host can also be a respondent
            other_names = [n for n in names if n != person["name"]]
            tasks.append(push(user_doc, meeting, ", ".join(other_names) or "1:1 약속"))

    await asyncio.gather(*tasks, return_exceptions=True)
    return records


async def confirm(
    event: dict, host: dict, capacity: int, meeting_minutes: int, meetings: list[dict]
) -> dict:
    """Stores the host's final schedule, closes the event and notifies people."""
    validate_meeting_minutes(event, meeting_minutes)

    _host_response, participants = await _load_people(event)
    by_key = {p["key"]: p for p in participants}

    length = timedelta(minutes=meeting_minutes)
    seen: set[str] = set()
    stored: list[dict] = []

    for meeting in meetings:
        start = meeting["start"]
        members = list(dict.fromkeys(meeting.get("participants") or []))
        if not members:
            continue
        if len(members) > capacity:
            raise InvalidMeeting(f"한 약속의 인원이 정원({capacity}명)을 초과했습니다.")
        for key in members:
            if key not in by_key:
                raise InvalidMeeting("응답자 목록에 없는 참가자가 포함되어 있습니다.")
            if key in seen:
                raise InvalidMeeting(f"{by_key[key]['name']}님이 두 번 배정되었습니다.")
            seen.add(key)
        stored.append({"start": start, "end": start + length, "participants": members})

    stored.sort(key=lambda m: m["start"])

    # The host is in every meeting, so overlapping blocks are impossible to attend.
    for earlier, later in pairwise(stored):
        if later["start"] < earlier["end"]:
            raise InvalidMeeting(
                "약속 시간이 서로 겹칩니다. 호스트는 동시에 참석할 수 없습니다."
            )

    was_confirmed = is_confirmed(event)
    finalization = {
        "status": "confirmed",
        "capacity": capacity,
        "meetingMinutes": meeting_minutes,
        "meetings": stored,
        "unassigned": [k for k in by_key if k not in seen],
        "confirmedAt": datetime.now(UTC),
        "confirmedBy": host["_id"],
    }

    # Clear out whatever a previous confirm() wrote to Google Calendar before
    # writing the new schedule, so re-confirming with changed assignments
    # doesn't leave stale duplicate events on anyone's real calendar.
    calendar_service.clear_synced_events_detached(
        (event.get("finalization") or {}).get("googleSyncedEvents")
    )
    finalization["googleSyncedEvents"] = await _sync_to_google_calendar(
        event, host, finalization, by_key
    )

    await events_col.update_one(
        {"_id": event["_id"]},
        {"$set": {"finalization": finalization, "isClosed": True}},
    )

    await _notify(event, host, finalization, by_key, updated=was_confirmed)
    return finalization


async def cancel(event: dict, host: dict) -> None:
    """Reopens the event for responses and tells everyone it is off."""
    finalization = event.get("finalization") or {}
    if finalization.get("status") != "confirmed":
        raise EventNotClosable("확정된 일정이 없습니다.")

    _host_response, participants = await _load_people(event)
    by_key = {p["key"]: p for p in participants}

    calendar_service.clear_synced_events_detached(finalization.get("googleSyncedEvents"))

    await events_col.update_one(
        {"_id": event["_id"]},
        {"$set": {"isClosed": False}, "$unset": {"finalization": ""}},
    )

    for meeting in finalization.get("meetings") or []:
        for key in meeting.get("participants") or []:
            person = by_key.get(key)
            if person and person["email"]:
                await email_service.send_meeting_cancelled_email(
                    person["email"], host, event, meeting["start"]
                )


async def _notify(
    event: dict, host: dict, finalization: dict, by_key: dict, *, updated: bool
) -> None:
    for meeting in finalization["meetings"]:
        others = [by_key[k]["name"] for k in meeting["participants"] if k in by_key]
        for key in meeting["participants"]:
            person = by_key.get(key)
            if not person or not person["email"]:
                continue
            await email_service.send_meeting_confirmed_email(
                person["email"],
                host,
                event,
                meeting["start"],
                meeting["end"],
                [n for n in others if n != person["name"]],
                updated=updated,
            )

    # People the optimizer could not place still deserve to hear the outcome.
    for key in finalization["unassigned"]:
        person = by_key.get(key)
        if person and person["email"]:
            await email_service.send_meeting_unassigned_email(
                person["email"], host, event
            )
