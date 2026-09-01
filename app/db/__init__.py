"""Central collection registry.

`app.db.mongo` owns the single MongoDB connection. Every collection used
anywhere in the app is declared here once and imported from here, e.g.::

    from app.db import events_col
    await events_col.find_one({"_id": event_id})
"""

from app.db.mongo import db

users_col = db["users"]
events_col = db["events"]
event_responses_col = db["event_responses"]
folders_col = db["folders"]
folder_events_col = db["folder_events"]
contacts_col = db["contacts"]
pending_signups_col = db["pending_signups"]
access_logs_col = db["access_logs"]
meeting_records_col = db["meeting_records"]


async def create_indexes() -> None:
    await users_col.create_index("email", unique=True)
    await users_col.create_index("name")

    await events_col.create_index("shortId", unique=True, sparse=True)
    await events_col.create_index("ownerId")

    await event_responses_col.create_index([("eventId", 1), ("userId", 1)], unique=True)

    await folders_col.create_index("userId")
    await folder_events_col.create_index([("folderId", 1), ("eventId", 1)], unique=True)
    await folder_events_col.create_index("userId")

    await contacts_col.create_index([("ownerId", 1), ("email", 1)], unique=True)
    await contacts_col.create_index("ownerId")

    # Pending sign-ups expire on their own once the emailed code goes stale.
    await pending_signups_col.create_index("email", unique=True)
    await pending_signups_col.create_index("expiresAt", expireAfterSeconds=0)

    # Admin dashboard traffic log - kept lean (one row per non-static
    # request, no bodies/headers) and self-pruning via TTL so "log a lot"
    # doesn't mean "grow forever".
    await access_logs_col.create_index("ts", expireAfterSeconds=60 * 24 * 3600)
    await access_logs_col.create_index("userId")

    # 학생지도비 신청서. One record per (event, meeting start) - meetings[]
    # has no id of its own and confirm() rewrites the whole finalization
    # subdoc, so the meeting's start time is the stable handle.
    await meeting_records_col.create_index("ownerId")
    await meeting_records_col.create_index(
        [("ownerId", 1), ("eventId", 1), ("meetingStart", 1)], unique=True
    )
