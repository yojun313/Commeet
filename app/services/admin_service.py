"""User/role management for the admin dashboard."""

from app.core.ids import to_object_id
from app.db import events_col, users_col


class UserNotFound(Exception):
    pass


class LastAdminError(Exception):
    """Refuses to demote the only remaining admin - the dashboard that lets
    you manage admins would otherwise lock everyone out of itself."""


async def list_users() -> list[dict]:
    users = await users_col.find({}).sort("createdAt", -1).to_list(length=None)
    owned_counts = await events_col.aggregate(
        [
            {"$match": {"isDeleted": {"$ne": True}}},
            {"$group": {"_id": "$ownerId", "count": {"$sum": 1}}},
        ]
    ).to_list(length=None)
    counts_by_owner = {c["_id"]: c["count"] for c in owned_counts}

    return [
        {
            "_id": str(u["_id"]),
            "email": u["email"],
            "name": u.get("name", ""),
            "isAdmin": bool(u.get("isAdmin")),
            "createdAt": u.get("createdAt"),
            "numEventsOwned": counts_by_owner.get(u["_id"], 0),
        }
        for u in users
    ]


async def get_user_detail(user_id: str) -> dict:
    oid = to_object_id(user_id)
    if oid is None:
        raise UserNotFound()
    user = await users_col.find_one({"_id": oid})
    if not user:
        raise UserNotFound()

    events = (
        await events_col.find({"ownerId": oid, "isDeleted": {"$ne": True}})
        .sort("_id", -1)
        .to_list(length=None)
    )

    return {
        "_id": str(user["_id"]),
        "email": user["email"],
        "name": user.get("name", ""),
        "isAdmin": bool(user.get("isAdmin")),
        "createdAt": user.get("createdAt"),
        "numEventsCreated": user.get("numEventsCreated", 0),
        "hasGoogleCalendar": bool(user.get("calendarAccounts")),
        "events": [
            {
                "_id": str(e["_id"]),
                "shortId": e.get("shortId"),
                "name": e.get("name", ""),
                "type": e.get("type"),
                "numResponses": e.get("numResponses", 0),
                "isClosed": bool(e.get("isClosed")),
                "isArchived": bool(e.get("isArchived")),
                "createdAt": e.get("createdAt"),
            }
            for e in events
        ],
    }


async def set_admin(target_user_id: str, is_admin: bool) -> None:
    oid = to_object_id(target_user_id)
    if oid is None:
        raise UserNotFound()

    if not is_admin:
        # Demoting - make sure at least one admin is left standing afterwards.
        target = await users_col.find_one({"_id": oid}, {"isAdmin": 1})
        if not target:
            raise UserNotFound()
        if target.get("isAdmin"):
            admin_count = await users_col.count_documents({"isAdmin": True})
            if admin_count <= 1:
                raise LastAdminError()

    result = await users_col.update_one({"_id": oid}, {"$set": {"isAdmin": is_admin}})
    if result.matched_count == 0:
        raise UserNotFound()
