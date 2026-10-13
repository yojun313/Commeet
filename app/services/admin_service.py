"""User/role management for the admin dashboard."""

from datetime import UTC, datetime

UTC_MIN = datetime.min.replace(tzinfo=UTC)

from app.core.ids import to_object_id
from app.db import event_responses_col, events_col, users_col


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


def _name_key(name: str) -> str:
    """같은 사람으로 칠 이름의 기준 - 띄어쓰기와 대소문자를 무시합니다.
    ("홍길동" = " 홍 길동 ", "Hong GilDong" = "hong gildong")"""
    return "".join((name or "").split()).casefold()


def _aware(dt):
    if dt is not None and dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


async def list_people() -> dict:
    """누적 이용자 - 가입한 사람 + 가입 없이 시간을 입력한 사람(게스트).

    게스트는 계정이 없어 이름 말고는 묶을 방법이 없으므로 **같은 이름은 한
    사람**으로 칩니다. 가입자와 이름이 같은 게스트도 그 가입자로 합칩니다 -
    로그인 전에 게스트로 한 번 응답하고 나중에 가입하는 경우가 흔합니다.
    응답 시각은 따로 저장하지 않으므로 응답 문서 _id(ObjectId)의 생성 시각을
    씁니다.
    """
    users = await users_col.find(
        {}, {"email": 1, "name": 1, "isAdmin": 1, "createdAt": 1}
    ).to_list(length=None)
    owned = await events_col.aggregate(
        [
            {"$match": {"isDeleted": {"$ne": True}}},
            {"$group": {"_id": "$ownerId", "count": {"$sum": 1}}},
        ]
    ).to_list(length=None)
    owned_by = {o["_id"]: o["count"] for o in owned}

    responses = await event_responses_col.find(
        {},
        {
            "eventId": 1,
            "userId": 1,
            "response.userId": 1,
            "response.name": 1,
            "response.email": 1,
        },
    ).to_list(length=None)

    members: dict[str, dict] = {}
    member_by_name: dict[str, dict] = {}
    for u in users:
        row = {
            "kind": "member",
            "_id": str(u["_id"]),
            "name": u.get("name", ""),
            "email": u.get("email", ""),
            "isAdmin": bool(u.get("isAdmin")),
            "firstSeen": _aware(u.get("createdAt")),
            "lastActive": _aware(u.get("createdAt")),
            "eventsOwned": owned_by.get(u["_id"], 0),
            "_events": set(),
            "alsoGuest": False,
        }
        members[row["_id"]] = row
        key = _name_key(row["name"])
        if key:
            member_by_name.setdefault(key, row)

    guests: dict[str, dict] = {}
    for doc in responses:
        resp = doc.get("response") or {}
        at = doc["_id"].generation_time
        if resp.get("userId"):
            row = members.get(str(doc.get("userId")))
            if row is None:
                continue  # 탈퇴한 계정
        else:
            name = (resp.get("name") or doc.get("userId") or "").strip()
            key = _name_key(name)
            if not key:
                continue
            row = member_by_name.get(key)
            if row is not None:
                row["alsoGuest"] = True
            else:
                row = guests.get(key)
                if row is None:
                    row = guests[key] = {
                        "kind": "guest",
                        "_id": None,
                        "name": " ".join(name.split()),
                        "email": "",
                        "isAdmin": False,
                        "firstSeen": at,
                        "lastActive": at,
                        "eventsOwned": 0,
                        "_events": set(),
                        "alsoGuest": False,
                    }
            if not row["email"] and (resp.get("email") or "").strip():
                row["email"] = resp["email"].strip()
        row["_events"].add(doc["eventId"])
        if row["firstSeen"] is None or at < row["firstSeen"]:
            row["firstSeen"] = at
        if row["lastActive"] is None or at > row["lastActive"]:
            row["lastActive"] = at

    # 게스트 상세(어느 방에 응답했나)에 쓸 방 이름. 게스트에게는 상세 API가
    # 따로 없으므로 목록에 같이 실어 보냅니다 - 게스트 수가 수백 명 규모라
    # 한 번에 보내도 가볍습니다.
    guest_event_ids = {e for g in guests.values() for e in g["_events"]}
    events_by_id = {
        e["_id"]: e
        for e in await events_col.find(
            {"_id": {"$in": list(guest_event_ids)}},
            {"name": 1, "shortId": 1, "isDeleted": 1},
        ).to_list(length=None)
    }

    people = []
    for row in [*members.values(), *guests.values()]:
        ev_ids = row.pop("_events")
        row["eventsResponded"] = len(ev_ids)
        if row["kind"] == "guest":
            row["events"] = [
                {
                    "_id": str(e["_id"]),
                    "shortId": e.get("shortId"),
                    "name": e.get("name", ""),
                    "isDeleted": bool(e.get("isDeleted")),
                }
                for eid in ev_ids
                if (e := events_by_id.get(eid))
            ]
        people.append(row)
    people.sort(
        key=lambda r: r["lastActive"] or r["firstSeen"] or UTC_MIN, reverse=True
    )

    return {
        "summary": {
            "total": len(people),
            "members": len(members),
            "guests": len(guests),
            "membersAlsoGuest": sum(1 for m in members.values() if m["alsoGuest"]),
        },
        "people": people,
    }


async def list_events() -> list[dict]:
    """관리자 대시보드의 방 목록 - 휴지통에 있는 방까지 전부.

    응답 수는 events.numResponses가 아니라 실제 응답 문서를 셉니다 - 카운터는
    증감만 하므로 예전 버그나 수동 정리로 어긋나 있을 수 있습니다.
    """
    events = await events_col.find(
        {},
        {
            "name": 1,
            "shortId": 1,
            "ownerId": 1,
            "createdAt": 1,
            "isClosed": 1,
            "isArchived": 1,
            "isDeleted": 1,
            "type": 1,
            "dates": 1,
            "blindAvailabilityEnabled": 1,
            "guidanceRecordsEnabled": 1,
        },
    ).to_list(length=None)
    counts = {
        r["_id"]: r
        for r in await event_responses_col.aggregate(
            [
                {
                    "$group": {
                        "_id": "$eventId",
                        "n": {"$sum": 1},
                        "last": {"$max": "$_id"},
                    }
                }
            ]
        ).to_list(length=None)
    }
    owner_ids = {e["ownerId"] for e in events if e.get("ownerId")}
    owners = {
        u["_id"]: u
        for u in await users_col.find(
            {"_id": {"$in": list(owner_ids)}}, {"name": 1, "email": 1}
        ).to_list(length=None)
    }

    rows = []
    for e in events:
        owner = owners.get(e.get("ownerId")) if e.get("ownerId") else None
        c = counts.get(e["_id"]) or {}
        dates = [d for d in (e.get("dates") or []) if hasattr(d, "year")]
        rows.append(
            {
                "_id": str(e["_id"]),
                "shortId": e.get("shortId"),
                "name": e.get("name", ""),
                "ownerName": (owner or {}).get("name", ""),
                "ownerEmail": (owner or {}).get("email", ""),
                "ownerId": str(e["ownerId"]) if e.get("ownerId") else None,
                "createdAt": _aware(e.get("createdAt")) or e["_id"].generation_time,
                "firstDate": _aware(min(dates)) if dates else None,
                "lastDate": _aware(max(dates)) if dates else None,
                "numResponses": c.get("n", 0),
                "lastResponseAt": c["last"].generation_time if c.get("last") else None,
                "isClosed": bool(e.get("isClosed")),
                "isArchived": bool(e.get("isArchived")),
                "isDeleted": bool(e.get("isDeleted")),
                "blind": bool(e.get("blindAvailabilityEnabled")),
                "records": bool(e.get("guidanceRecordsEnabled")),
            }
        )
    rows.sort(key=lambda r: r["createdAt"] or UTC_MIN, reverse=True)
    return rows


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
