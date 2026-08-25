import re

from bson import ObjectId

from app.db import attendees_col, event_responses_col, events_col, users_col
from app.services.auth_service import default_calendar_options

_OBJECT_ID_RE = re.compile(r"^[0-9a-fA-F]{24}$")


async def _attach_participant_names(events: list[dict]) -> None:
    """Confirmed meetings only store the raw `participants` keys (a Mongo
    ObjectId hex string for a registered user, or the guest's literal name
    for a manual invite - see finalize_service._load_people). The calendar
    page wants real display names front and center, so resolve the
    registered-user keys here in one batched query rather than making every
    caller do it."""
    ids: set[str] = set()
    for event in events:
        fin = event.get("finalization")
        if not fin:
            continue
        for meeting in fin.get("meetings") or []:
            for key in meeting.get("participants") or []:
                if _OBJECT_ID_RE.match(key):
                    ids.add(key)
    if not ids:
        return

    docs = await users_col.find(
        {"_id": {"$in": [ObjectId(i) for i in ids]}}, {"name": 1, "email": 1}
    ).to_list(length=None)
    name_by_id = {
        str(doc["_id"]): (doc.get("name") or doc.get("email") or "").strip()
        for doc in docs
    }

    for event in events:
        fin = event.get("finalization")
        if not fin:
            continue
        for meeting in fin.get("meetings") or []:
            meeting["participantNames"] = [
                name_by_id.get(key, key) for key in (meeting.get("participants") or [])
            ]


async def get_dashboard_events(user: dict) -> list[dict]:
    """Union of: events the user responded to, events they're invited to as a
    Group attendee (not declined), and events they own."""
    user_id = user["_id"]
    user_id_str = str(user_id)

    responded_docs = await event_responses_col.find(
        {"userId": user_id_str}, {"eventId": 1}
    ).to_list(length=None)
    responded_event_ids = {d["eventId"] for d in responded_docs}

    attendee_docs = await attendees_col.find(
        {"email": user["email"], "declined": {"$ne": True}}, {"eventId": 1}
    ).to_list(length=None)
    attendee_event_ids = {d["eventId"] for d in attendee_docs}

    owned_docs = await events_col.find(
        {"ownerId": user_id, "isDeleted": {"$ne": True}}, {"_id": 1}
    ).to_list(length=None)
    owned_event_ids = {d["_id"] for d in owned_docs}

    all_ids = responded_event_ids | attendee_event_ids | owned_event_ids
    if not all_ids:
        return []

    events = (
        await events_col.find(
            {"_id": {"$in": list(all_ids)}, "isDeleted": {"$ne": True}}
        )
        .sort("_id", -1)
        .to_list(length=None)
    )
    for event in events:
        event["hasResponded"] = event["_id"] in responded_event_ids
    await _attach_participant_names(events)
    return events


async def update_name(user: dict, name: str) -> None:
    await users_col.update_one(
        {"_id": user["_id"]},
        {"$set": {"name": name.strip()}},
    )


async def update_calendar_options(
    user: dict, buffer_time: dict | None, working_hours: dict | None
) -> dict:
    options = user.get("calendarOptions") or default_calendar_options()
    if buffer_time is not None:
        options["bufferTime"] = buffer_time
    if working_hours is not None:
        options["workingHours"] = working_hours
    await users_col.update_one(
        {"_id": user["_id"]}, {"$set": {"calendarOptions": options}}
    )
    return options


async def delete_account(user: dict) -> None:
    await users_col.delete_one({"_id": user["_id"]})


async def get_public_profile(user_id: str) -> dict | None:
    from app.core.ids import to_object_id

    oid = to_object_id(user_id)
    if oid is None:
        return None
    user = await users_col.find_one({"_id": oid})
    if not user:
        return None
    return {
        "_id": str(user["_id"]),
        "name": user.get("name", ""),
        "picture": user.get("picture", ""),
    }
