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
from app.services.auth_service import normalize_email


class ContactAlreadyExists(Exception):
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


_DETAIL_FIELDS = (
    "relation",
    "degree",
    "gradSchool",
    "department",
    "year",
    "semester",
    "studentId",
    "status",
    "phone",
    "memo",
)


async def add_contact(
    owner: dict, name: str, email: str, details: dict | None = None
) -> dict:
    # Unlike signing up (auth_service.is_allowed_email), a contact you save
    # doesn't need to be a Commeet/postech account at all - you might just want
    # to email-invite someone external to an event. `AddContactRequest.email`
    # (Pydantic EmailStr) already validates it's a well-formed address.
    email = normalize_email(email)

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
    # Roster detail fields (구분/과정/대학원/학과/학년/학기/학번/학적상태/전화번호)
    # are all optional - a plain name+email contact and a fully-detailed one
    # coexist in the same collection, so only set the ones actually given.
    for field in _DETAIL_FIELDS:
        value = (details or {}).get(field)
        if value:
            doc[field] = value

    result = await contacts_col.insert_one(doc)
    doc["_id"] = result.inserted_id
    return doc


async def upsert_contact(
    owner: dict, name: str, email: str, details: dict | None = None
) -> bool:
    """Adds the contact, or refreshes the existing one with the same email.

    Returns True when a new contact was created, False when an existing one
    was updated. Email is the identity here (one address = one contact per
    owner), which is what lets a roster be pasted in repeatedly.

    Only values actually supplied are written - unlike `update_contact`,
    a blank/absent field leaves whatever is stored alone. A pasted roster
    row never carries a memo, so re-pasting refreshes the roster columns
    without wiping notes the owner typed by hand.
    """
    email = normalize_email(email)
    existing = await contacts_col.find_one({"ownerId": owner["_id"], "email": email})
    if existing is None:
        await add_contact(owner, name, email, details)
        return True

    set_fields: dict = {}
    if (name or "").strip():
        set_fields["name"] = name.strip()
    for field in _DETAIL_FIELDS:
        value = (details or {}).get(field)
        if value:
            set_fields[field] = value
    if set_fields:
        await contacts_col.update_one({"_id": existing["_id"]}, {"$set": set_fields})
    return False


async def update_contact(
    owner: dict, contact_id: str, name: str, email: str, details: dict | None = None
) -> bool:
    """Full-form edit: whatever `details` holds becomes the contact's exact
    new state for those fields - a field left blank in the edit form clears
    it (unlike add_contact, which only ever fills fields in, never wipes
    them), since this represents "save what the form now shows"."""
    oid = to_object_id(contact_id)
    if oid is None:
        return False

    email = normalize_email(email)
    other = await contacts_col.find_one({"ownerId": owner["_id"], "email": email})
    if other and other["_id"] != oid:
        raise ContactAlreadyExists()

    matched = await users_col.find_one({"email": email})

    set_fields = {
        "name": name.strip(),
        "email": email,
        "userId": matched["_id"] if matched else None,
    }
    unset_fields = {}
    for field in _DETAIL_FIELDS:
        value = (details or {}).get(field)
        if value:
            set_fields[field] = value
        else:
            unset_fields[field] = ""

    update: dict = {"$set": set_fields}
    if unset_fields:
        update["$unset"] = unset_fields

    result = await contacts_col.update_one(
        {"_id": oid, "ownerId": owner["_id"]}, update
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
        entry = {
            "_id": str(c["_id"]),
            "name": c.get("name", ""),
            "email": c.get("email", ""),
            "registered": bool(c.get("userId")),
            "registeredName": registered_name,
        }
        for field in _DETAIL_FIELDS:
            if c.get(field):
                entry[field] = c[field]
        result.append(entry)
    return result
