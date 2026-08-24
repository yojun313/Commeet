"""Event & response business logic - the core scheduling feature.

Mirrors timeful.app's `routes/events.go` + `db/events.go`, with these
deliberate simplifications (see project notes): no sign-up-form / "dates
only" / "specific times per day" modes, and reminder emails are sent once
(as an invite) instead of on a scheduled cadence, since there's no task
queue in this port.
"""

from datetime import UTC, datetime

from bson import ObjectId

from app.core.ids import generate_short_id, to_object_id
from app.db import (
    attendees_col,
    event_responses_col,
    events_col,
    folder_events_col,
    users_col,
)
from app.schemas.event import EventPayload, EventType
from app.services import email_service


class NotEventOwner(Exception):
    pass


class NotSignedIn(Exception):
    pass


class BlindAvailabilityViolation(Exception):
    pass


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------


async def generate_unique_short_id() -> str:
    while True:
        candidate = generate_short_id()
        if await events_col.find_one({"shortId": candidate}) is None:
            return candidate


async def get_event_by_id(event_id: str) -> dict | None:
    oid = to_object_id(event_id)
    if oid is None:
        return None
    return await events_col.find_one({"_id": oid, "isDeleted": {"$ne": True}})


async def get_event_by_short_id(short_id: str) -> dict | None:
    return await events_col.find_one({"shortId": short_id, "isDeleted": {"$ne": True}})


async def get_event_by_either_id(event_id: str) -> dict | None:
    """Event links use either the Mongo _id or the short, shareable id."""
    if len(event_id) <= 10:
        return await get_event_by_short_id(event_id)
    return await get_event_by_id(event_id)


async def get_event_responses(event_id: ObjectId) -> list[dict]:
    return await event_responses_col.find({"eventId": event_id}).to_list(length=None)


async def get_attendees(event_id: ObjectId) -> list[dict]:
    return await attendees_col.find({"eventId": event_id}).to_list(length=None)


async def find_response(event_id: ObjectId, user_key: str) -> dict | None:
    return await event_responses_col.find_one({"eventId": event_id, "userId": user_key})


async def guest_name_exists(event_id: ObjectId, guest_name: str) -> bool:
    oid = to_object_id(guest_name)
    if oid is not None and await users_col.find_one({"_id": oid}):
        return True
    return await find_response(event_id, guest_name) is not None


async def rename_guest(event_id: ObjectId, old_name: str, new_name: str) -> None:
    await event_responses_col.update_one(
        {"eventId": event_id, "userId": old_name},
        {"$set": {"userId": new_name, "response.name": new_name}},
    )


# ---------------------------------------------------------------------------
# Create / edit / delete
# ---------------------------------------------------------------------------


async def create_event(payload: EventPayload, owner: dict | None) -> dict:
    now = datetime.now(UTC)
    event = {
        "ownerId": owner["_id"] if owner else None,
        "name": payload.name,
        "description": payload.description,
        "isArchived": False,
        "isDeleted": False,
        "duration": payload.duration,
        "dates": payload.dates,
        "startOnMonday": payload.startOnMonday,
        "notificationsEnabled": payload.notificationsEnabled,
        "blindAvailabilityEnabled": payload.blindAvailabilityEnabled,
        "collectEmails": payload.collectEmails,
        "timeIncrement": payload.timeIncrement,
        "sendEmailAfterXResponses": payload.sendEmailAfterXResponses,
        "type": payload.type.value,
        "remindees": [],
        "numResponses": 0,
        "createdAt": now,
    }
    event["shortId"] = await generate_unique_short_id()

    result = await events_col.insert_one(event)
    event["_id"] = result.inserted_id

    if payload.type == EventType.GROUP:
        emails = list(
            dict.fromkeys([*(([owner["email"]]) if owner else []), *payload.attendees])
        )
        for email in emails:
            await attendees_col.update_one(
                {"eventId": event["_id"], "email": email},
                {"$setOnInsert": {"declined": False}},
                upsert=True,
            )
        for email in payload.attendees:
            await email_service.send_group_invite_email(email, owner, event)
    else:
        remindees = [
            {"email": email, "responded": False} for email in payload.remindees
        ]
        if remindees:
            await events_col.update_one(
                {"_id": event["_id"]}, {"$set": {"remindees": remindees}}
            )
            event["remindees"] = remindees
        for email in payload.remindees:
            await email_service.send_event_invite_email(email, owner, event)

    if owner:
        await users_col.update_one(
            {"_id": owner["_id"]}, {"$inc": {"numEventsCreated": 1}}
        )

    return event


async def update_event(
    event: dict, payload: EventPayload, requester: dict | None
) -> dict:
    owner_id = event.get("ownerId")
    requester_id = requester["_id"] if requester else None
    if owner_id is not None and owner_id != requester_id:
        raise NotEventOwner()

    updates = {
        "name": payload.name,
        "description": payload.description,
        "duration": payload.duration,
        "dates": payload.dates,
        "startOnMonday": payload.startOnMonday,
        "notificationsEnabled": payload.notificationsEnabled,
        "blindAvailabilityEnabled": payload.blindAvailabilityEnabled,
        "collectEmails": payload.collectEmails,
        "sendEmailAfterXResponses": payload.sendEmailAfterXResponses,
        "type": payload.type.value,
    }

    if payload.type == EventType.GROUP:
        existing_attendees = await get_attendees(event["_id"])
        existing_emails = {a["email"] for a in existing_attendees}

        owner_email = None
        if event.get("ownerId"):
            owner_doc = await users_col.find_one({"_id": event["ownerId"]})
            owner_email = owner_doc["email"] if owner_doc else None

        new_emails = set(payload.attendees)
        if owner_email:
            new_emails.add(owner_email)

        added = new_emails - existing_emails
        removed = existing_emails - new_emails

        for email in removed:
            await attendees_col.delete_one({"eventId": event["_id"], "email": email})
            removed_user = await users_col.find_one({"email": email})
            if removed_user:
                deleted = await event_responses_col.delete_one(
                    {"eventId": event["_id"], "userId": str(removed_user["_id"])}
                )
                if deleted.deleted_count:
                    await events_col.update_one(
                        {"_id": event["_id"]}, {"$inc": {"numResponses": -1}}
                    )

        for email in added:
            await attendees_col.update_one(
                {"eventId": event["_id"], "email": email},
                {"$setOnInsert": {"declined": False}},
                upsert=True,
            )
            await email_service.send_group_invite_email(email, requester, event)
    else:
        old_remindees = {r["email"]: r for r in event.get("remindees") or []}
        new_remindee_emails = set(payload.remindees)
        kept_emails = set(old_remindees) & new_remindee_emails
        added_emails = new_remindee_emails - set(old_remindees)

        updated_remindees = [old_remindees[email] for email in kept_emails]
        for email in added_emails:
            updated_remindees.append({"email": email, "responded": False})
            await email_service.send_event_invite_email(email, requester, event)

        updates["remindees"] = updated_remindees

    await events_col.update_one({"_id": event["_id"]}, {"$set": updates})
    return await events_col.find_one({"_id": event["_id"]})


async def delete_event(event: dict, requester: dict) -> None:
    responses = await get_event_responses(event["_id"])
    has_other_responses = any(r["userId"] != str(requester["_id"]) for r in responses)

    if has_other_responses:
        # Someone else already responded - keep their data, just hide the event.
        await events_col.update_one(
            {"_id": event["_id"]}, {"$set": {"isDeleted": True}}
        )
    else:
        await events_col.delete_one({"_id": event["_id"]})
        await event_responses_col.delete_many({"eventId": event["_id"]})
        await attendees_col.delete_many({"eventId": event["_id"]})
        await folder_events_col.delete_many({"eventId": event["_id"]})


async def archive_event(event: dict, archived: bool) -> None:
    await events_col.update_one(
        {"_id": event["_id"]}, {"$set": {"isArchived": archived}}
    )


async def duplicate_event(
    event: dict, new_name: str, copy_availability: bool, requester: dict | None
) -> dict:
    now = datetime.now(UTC)
    new_event = {
        k: v
        for k, v in event.items()
        if k not in {"_id", "shortId", "numResponses", "remindees", "createdAt"}
    }
    new_event.update(
        {
            "name": new_name,
            "ownerId": requester["_id"] if requester else None,
            "isArchived": False,
            "isDeleted": False,
            "remindees": [],
            "numResponses": 0,
            "createdAt": now,
        }
    )
    new_event["shortId"] = await generate_unique_short_id()
    result = await events_col.insert_one(new_event)
    new_event["_id"] = result.inserted_id

    if copy_availability:
        responses = await get_event_responses(event["_id"])
        if responses:
            await event_responses_col.insert_many(
                [
                    {
                        "eventId": new_event["_id"],
                        "userId": r["userId"],
                        "response": r["response"],
                    }
                    for r in responses
                ]
            )
            await events_col.update_one(
                {"_id": new_event["_id"]}, {"$set": {"numResponses": len(responses)}}
            )
            new_event["numResponses"] = len(responses)

        if event["type"] == EventType.GROUP.value:
            attendees = await get_attendees(event["_id"])
            if attendees:
                await attendees_col.insert_many(
                    [
                        {
                            "eventId": new_event["_id"],
                            "email": a["email"],
                            "declined": a.get("declined", False),
                        }
                        for a in attendees
                    ]
                )

    if requester:
        await users_col.update_one(
            {"_id": requester["_id"]}, {"$inc": {"numEventsCreated": 1}}
        )

    return new_event


async def add_attendee(event: dict, email: str) -> None:
    """Grants a group invitee access, without clearing an existing decline."""
    await attendees_col.update_one(
        {"eventId": event["_id"], "email": email},
        {"$setOnInsert": {"declined": False}},
        upsert=True,
    )


async def decline_invite(event: dict, user: dict) -> bool:
    result = await attendees_col.update_one(
        {"eventId": event["_id"], "email": user["email"]},
        {"$set": {"declined": True}},
    )
    return result.matched_count > 0


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------


async def upsert_response(
    event: dict, payload, requester: dict | None
) -> tuple[bool, str]:
    """Returns (is_new_response, user_key)."""
    if event.get("blindAvailabilityEnabled") and requester and payload.guest:
        owner_id = event.get("ownerId")
        if owner_id != requester["_id"]:
            raise BlindAvailabilityViolation()

    if payload.guest:
        if not payload.name:
            raise ValueError("Guest responses require a name")
        user_key = payload.name
        response = {
            "name": payload.name,
            "email": payload.email or "",
            "userId": None,
            "availability": payload.availability,
            "ifNeeded": payload.ifNeeded,
        }
    else:
        if not requester:
            raise NotSignedIn()
        user_key = str(requester["_id"])
        response = {
            "userId": requester["_id"],
            "name": "",
            "email": "",
            "availability": payload.availability,
            "ifNeeded": payload.ifNeeded,
            "useCalendarAvailability": payload.useCalendarAvailability,
            "enabledCalendars": payload.enabledCalendars,
        }

        if event["type"] == EventType.GROUP.value:
            await attendees_col.update_one(
                {"eventId": event["_id"], "email": requester["email"]},
                {"$set": {"declined": False}},
            )
            existing = await find_response(event["_id"], user_key)
            manual = dict(
                (existing or {}).get("response", {}).get("manualAvailability") or {}
            )
            if payload.manualAvailability:
                manual.update(payload.manualAvailability)
            response["manualAvailability"] = manual

    existing = await find_response(event["_id"], user_key)
    is_new = existing is None

    if is_new:
        await event_responses_col.insert_one(
            {"eventId": event["_id"], "userId": user_key, "response": response}
        )
        await events_col.update_one(
            {"_id": event["_id"]}, {"$inc": {"numResponses": 1}}
        )
    else:
        await event_responses_col.update_one(
            {"_id": existing["_id"]}, {"$set": {"response": response}}
        )

    return is_new, user_key


async def delete_response(event: dict, payload, requester: dict | None) -> None:
    if payload.guest:
        if not payload.name:
            raise ValueError("Guest name required")
        result = await event_responses_col.delete_one(
            {"eventId": event["_id"], "userId": payload.name}
        )
    else:
        if not requester:
            raise NotSignedIn()
        user_key = str(requester["_id"])
        target = payload.userId or user_key
        owner_id = event.get("ownerId")
        if target != user_key and owner_id != requester["_id"]:
            raise NotEventOwner()

        result = await event_responses_col.delete_one(
            {"eventId": event["_id"], "userId": target}
        )

        if event["type"] == EventType.GROUP.value and target == user_key:
            await attendees_col.update_one(
                {"eventId": event["_id"], "email": requester["email"]},
                {"$set": {"declined": True}},
            )

    if result.deleted_count:
        await events_col.update_one(
            {"_id": event["_id"]}, {"$inc": {"numResponses": -1}}
        )


# ---------------------------------------------------------------------------
# Response shaping / privacy
# ---------------------------------------------------------------------------


async def _decorate_response(
    doc: dict, *, show_emails: bool, keep_group_emails: bool, include_availability: bool
) -> dict | None:
    resp = dict(doc["response"])
    user_oid = resp.get("userId")

    if user_oid:
        user = await users_col.find_one({"_id": user_oid})
        if user is None:
            return None  # account was deleted
        email_visible = show_emails or keep_group_emails
        resp["user"] = {
            "_id": str(user["_id"]),
            "name": user.get("name", ""),
            "picture": user.get("picture", ""),
            "email": user.get("email", "") if email_visible else "",
        }
    else:
        resp["user"] = {
            "name": resp.get("name", ""),
            "email": resp.get("email", "") if show_emails else "",
        }

    if not show_emails:
        resp["email"] = ""

    if not include_availability:
        resp.pop("availability", None)
        resp.pop("ifNeeded", None)
        resp.pop("manualAvailability", None)

    resp.pop("userId", None)
    return resp


async def build_responses_map(
    event: dict, responses: list[dict], *, is_owner: bool, include_availability: bool
) -> dict:
    show_emails = is_owner and bool(event.get("collectEmails"))
    is_group = event["type"] == EventType.GROUP.value
    result: dict[str, dict] = {}
    for doc in responses:
        decorated = await _decorate_response(
            doc,
            show_emails=show_emails,
            keep_group_emails=is_group,
            include_availability=include_availability,
        )
        if decorated is not None:
            result[doc["userId"]] = decorated
    return result


def apply_blind_filter(
    event: dict,
    responses_map: dict,
    *,
    viewer: dict | None,
    is_owner: bool,
    guest_name: str | None,
) -> dict:
    if not event.get("blindAvailabilityEnabled") or is_owner:
        return responses_map
    if viewer:
        key = str(viewer["_id"])
        return {key: responses_map[key]} if key in responses_map else {}
    if guest_name and guest_name in responses_map:
        return {guest_name: responses_map[guest_name]}
    return {}


def _parse_iso(value: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


def filter_response_time_range(
    resp: dict, time_min: datetime, time_max: datetime
) -> dict:
    resp = dict(resp)
    resp["availability"] = [
        t for t in resp.get("availability", []) if time_min <= t <= time_max
    ]
    resp["ifNeeded"] = [
        t for t in resp.get("ifNeeded", []) if time_min <= t <= time_max
    ]
    manual = resp.get("manualAvailability") or {}
    resp["manualAvailability"] = {
        day: times
        for day, times in manual.items()
        if (parsed := _parse_iso(day)) and time_min <= parsed <= time_max
    }
    return resp


async def get_filtered_responses_map(
    event: dict, time_min: datetime, time_max: datetime, *, is_owner: bool
) -> dict:
    responses = await get_event_responses(event["_id"])
    full_map = await build_responses_map(
        event, responses, is_owner=is_owner, include_availability=True
    )
    return {
        key: filter_response_time_range(resp, time_min, time_max)
        for key, resp in full_map.items()
    }


async def get_calendar_availabilities(
    event: dict, time_min: datetime, time_max: datetime, viewer: dict
) -> dict:
    from app.services import calendar_service

    responses = await get_event_responses(event["_id"])
    candidates = []
    for doc in responses:
        resp = doc["response"]
        if resp.get("useCalendarAvailability") and resp.get("userId"):
            user = await users_col.find_one({"_id": resp["userId"]})
            if user:
                candidates.append(
                    (doc["userId"], user, resp.get("enabledCalendars") or {})
                )

    result: dict[str, list[dict]] = {}
    for user_key, user, enabled_calendars in candidates:
        try:
            events_by_account = await calendar_service.get_users_calendar_events(
                user,
                time_min,
                time_max,
                account_keys_filter=set(enabled_calendars.keys()) or None,
            )
        except calendar_service.GoogleCalendarNotConfigured:
            events_by_account = {}

        enabled_calendar_ids = {
            cid for ids in enabled_calendars.values() for cid in ids
        }
        merged = []
        for _account_key, payload in events_by_account.items():
            for calendar_event in payload.get("calendarEvents", []):
                if (
                    enabled_calendar_ids
                    and calendar_event["calendarId"] not in enabled_calendar_ids
                ):
                    continue
                if user_key != str(viewer["_id"]):
                    calendar_event = {**calendar_event, "summary": "BUSY"}
                merged.append(calendar_event)
        result[user_key] = merged

    return result
