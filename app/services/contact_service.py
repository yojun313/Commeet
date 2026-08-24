"""Personal address book ("연락처").

Each contact belongs to one owner - there is no mutual friend request or
acceptance step, because a contact may be someone who has not signed up yet.
Contacts that do match a registered account keep a `userId` link so their
profile name/picture stays current.
"""

import re
from datetime import UTC, datetime

from bson import ObjectId

from app.core.ids import to_object_id
from app.db import contacts_col, users_col
from app.services.auth_service import is_allowed_email, normalize_email


class ContactAlreadyExists(Exception):
    pass


class InvalidEmailDomain(Exception):
    pass


def _escape_regex(text: str) -> str:
    return re.escape(text)


async def search_users(
    query: str, exclude_user_id: ObjectId, owner_id: ObjectId
) -> list[dict]:
    """Finds registered users by email or name, marking ones already saved."""
    query = (query or "").strip()
    if not query:
        return []

    pattern = {"$regex": _escape_regex(query), "$options": "i"}
    users = (
        await users_col.find(
            {
                "$or": [{"email": pattern}, {"name": pattern}],
                "_id": {"$ne": exclude_user_id},
            }
        )
        .limit(10)
        .to_list(length=None)
    )

    existing = await contacts_col.find({"ownerId": owner_id}, {"email": 1}).to_list(
        length=None
    )
    saved_emails = {c["email"] for c in existing}

    return [
        {
            "_id": str(u["_id"]),
            "name": u.get("name", ""),
            "email": u.get("email", ""),
            "picture": u.get("picture", ""),
            "alreadyAdded": u.get("email", "") in saved_emails,
        }
        for u in users
    ]


async def add_contact(owner: dict, name: str, email: str) -> dict:
    email = normalize_email(email)
    if not is_allowed_email(email):
        raise InvalidEmailDomain()

    if await contacts_col.find_one({"ownerId": owner["_id"], "email": email}):
        raise ContactAlreadyExists()

    # Link to a real account when one exists, so the contact shows their
    # current profile name rather than whatever was typed here.
    matched = await users_col.find_one({"email": email})

    doc = {
        "ownerId": owner["_id"],
        "email": email,
        "name": (name or "").strip()
        or (matched.get("name", "") if matched else "")
        or email.split("@")[0],
        "userId": matched["_id"] if matched else None,
        "createdAt": datetime.now(UTC),
    }
    result = await contacts_col.insert_one(doc)
    doc["_id"] = result.inserted_id
    return doc


async def update_contact(owner: dict, contact_id: str, name: str) -> bool:
    oid = to_object_id(contact_id)
    if oid is None:
        return False
    result = await contacts_col.update_one(
        {"_id": oid, "ownerId": owner["_id"]}, {"$set": {"name": name.strip()}}
    )
    return result.matched_count > 0


async def delete_contact(owner: dict, contact_id: str) -> bool:
    oid = to_object_id(contact_id)
    if oid is None:
        return False
    result = await contacts_col.delete_one({"_id": oid, "ownerId": owner["_id"]})
    return result.deleted_count > 0


async def list_contacts(owner: dict) -> list[dict]:
    contacts = (
        await contacts_col.find({"ownerId": owner["_id"]})
        .sort("name", 1)
        .to_list(length=None)
    )

    result = []
    for c in contacts:
        registered_name = None
        if c.get("userId"):
            linked = await users_col.find_one(
                {"_id": c["userId"]}, {"name": 1, "picture": 1}
            )
            if linked:
                registered_name = linked.get("name")
        result.append(
            {
                "_id": str(c["_id"]),
                "name": c.get("name", ""),
                "email": c.get("email", ""),
                "registered": bool(c.get("userId")),
                "registeredName": registered_name,
            }
        )
    return result
