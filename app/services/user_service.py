import hashlib
import re

from bson import ObjectId

from app.db import event_responses_col, events_col, users_col
from app.services.auth_service import default_calendar_options
from app.services.event_service import CO_HOST_PERM_DEFAULTS, co_host_perms

# 공동주최자 권한을 기억해 둘 사람 수 상한 - 사용자 문서가 끝없이 커지지 않게.
_CO_HOST_PREFS_LIMIT = 200

_OBJECT_ID_RE = re.compile(r"^[0-9a-fA-F]{24}$")


async def get_dashboard_version(user: dict) -> str:
    """대시보드와 캘린더가 몇 초마다 두드리는 값싼 지문(fingerprint).

    두 화면 모두 get_dashboard_events()가 돌려주는 목록을 그리는데, 그건
    일정 문서 전체를 읽고 주최자 이름까지 붙이는 무거운 조회입니다. 그걸
    그대로 반복하는 대신 **어떤 일정이 목록에 있고 각각 몇 번째 버전인가**만
    추려서 해시로 만듭니다. 남이 내 일정에 응답했거나, 나를 초대한 일정이
    확정됐거나, 참여 중이던 일정이 사라지면 이 값이 달라집니다.

    id 수집 질의는 get_dashboard_events()와 같지만 전부 인덱스가 있고
    projection만 가져오므로, 문서 본문도 주최자 이름 조회도 없습니다.

    일정의 버전(v)을 올리는 것은 app.main의 bump_event_version_middleware
    한 곳입니다 - 폴더 이동처럼 나 혼자만 보는 변경은 여기 잡히지 않는데,
    남에게 보여 줄 것이 없으니 그래도 됩니다.
    """
    user_id = user["_id"]

    responded = await event_responses_col.find(
        {"userId": str(user_id)}, {"eventId": 1}
    ).to_list(length=None)
    ids = {d["eventId"] for d in responded}
    owned_or_visible = await events_col.find(
        {
            "$or": [
                {"ownerId": user_id},
                {"coHostIds": user_id},
                {"_id": {"$in": list(ids)}},
            ],
            "isDeleted": {"$ne": True},
        },
        {"v": 1},
    ).to_list(length=None)

    fingerprint = ";".join(
        sorted(f"{d['_id']}:{d.get('v') or 0}" for d in owned_or_visible)
    )
    return hashlib.md5(fingerprint.encode()).hexdigest()[:16]


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
    """내가 응답한 일정, 내가 만든 일정, 공동주최자로 지정된 일정의 합집합."""
    user_id = user["_id"]
    user_id_str = str(user_id)

    responded_docs = await event_responses_col.find(
        {"userId": user_id_str}, {"eventId": 1}
    ).to_list(length=None)
    responded_event_ids = {d["eventId"] for d in responded_docs}

    owned_docs = await events_col.find(
        {
            "$or": [{"ownerId": user_id}, {"coHostIds": user_id}],
            "isDeleted": {"$ne": True},
        },
        {"_id": 1},
    ).to_list(length=None)
    owned_event_ids = {d["_id"] for d in owned_docs}

    all_ids = responded_event_ids | owned_event_ids
    if not all_ids:
        return []

    events = (
        await events_col.find(
            {"_id": {"$in": list(all_ids)}, "isDeleted": {"$ne": True}}
        )
        .sort("_id", -1)
        .to_list(length=None)
    )

    # 대시보드는 "내가 만든 일정"과 "참여 중인 일정"을 나눠 보여 주고, 후자는
    # 수정·복제·보관·삭제를 막습니다. 클라이언트가 소유자 id를 따로 알 필요가
    # 없도록 여기서 판정해 내려 줍니다.
    owner_ids = {
        e["ownerId"] for e in events if e.get("ownerId") and e["ownerId"] != user_id
    }
    owner_names = {}
    if owner_ids:
        docs = await users_col.find(
            {"_id": {"$in": list(owner_ids)}}, {"name": 1, "email": 1}
        ).to_list(length=None)
        owner_names = {
            d["_id"]: (d.get("name") or d.get("email") or "").strip() for d in docs
        }

    # 내 일정의 공동주최자 명단 - 대시보드의 "수정" 창이 지금 명단을 채워
    # 보여 줘야, 저장할 때 명단이 비어 있는 채로 덮어쓰지 않습니다.
    co_ids = {
        i
        for e in events
        if e.get("ownerId") == user_id
        for i in (e.get("coHostIds") or [])
    }
    co_docs = {}
    if co_ids:
        docs = await users_col.find(
            {"_id": {"$in": list(co_ids)}}, {"name": 1, "email": 1}
        ).to_list(length=None)
        co_docs = {d["_id"]: d for d in docs}

    for event in events:
        event["hasResponded"] = event["_id"] in responded_event_ids
        event["isOwner"] = event.get("ownerId") == user_id
        event["isCoHost"] = not event["isOwner"] and user_id in (
            event.get("coHostIds") or []
        )
        if event["isOwner"]:
            event["coHosts"] = [
                {
                    "_id": str(i),
                    "name": (co_docs[i].get("name") or "").strip(),
                    "email": co_docs[i].get("email", ""),
                    "perms": co_host_perms(event, i),
                }
                for i in (event.get("coHostIds") or [])
                if i in co_docs
            ]
        else:
            # 남의 일정 응답자에게 다른 공동주최자가 누구인지까지 내려 줄
            # 이유는 없습니다. 내가 공동주최자인지, 무엇을 할 수 있는지만.
            if event["isCoHost"]:
                event["myPerms"] = co_host_perms(event, user_id)
            event.pop("coHostIds", None)
        event.pop("coHostPerms", None)
        if not event["isOwner"]:
            # 남의 일정에는 누가 만든 것인지 보여 줍니다. 소유자가 없는
            # (게스트가 만든) 일정도 있어 기본값을 둡니다.
            event["ownerName"] = owner_names.get(event.get("ownerId")) or "익명"
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


# --------------------------------------------------------------------- #
# 공동주최자 권한 기억                                                     #
# --------------------------------------------------------------------- #
#
# 일정 창에서 공동주최자의 체크를 바꾸면 그 사람 앞으로 기억해 두었다가,
# 다음에 같은 사람을 공동주최자로 넣을 때 그대로 채웁니다. 처음 넣는 사람은
# 가장 최근에 고른 권한으로 시작합니다. 이메일에는 점이 들어가 Mongo 키로
# 쓰기 곤란해서, [{email, perms}] 목록으로 둡니다 (최근 것이 뒤).


def _clean_perms(perms: dict | None) -> dict[str, bool]:
    perms = perms or {}
    return {k: bool(perms.get(k, v)) for k, v in CO_HOST_PERM_DEFAULTS.items()}


def get_co_host_prefs(user: dict) -> dict:
    rows = user.get("coHostPrefs") or []
    by_email = {
        r["email"]: _clean_perms(r.get("perms")) for r in rows if r.get("email")
    }
    return {
        "byEmail": by_email,
        "last": _clean_perms(rows[-1].get("perms")) if rows else None,
    }


async def save_co_host_prefs(user: dict, entries: list[tuple[str, dict]]) -> None:
    """(이메일, 권한) 들을 기억합니다. 넘긴 순서대로 "최근"이 됩니다."""
    if not entries:
        return
    fresh = await users_col.find_one({"_id": user["_id"]}, {"coHostPrefs": 1}) or {}
    rows = [r for r in (fresh.get("coHostPrefs") or []) if r.get("email")]
    for email, perms in entries:
        email = (email or "").strip().lower()
        if not email:
            continue
        rows = [r for r in rows if r["email"] != email]
        rows.append({"email": email, "perms": _clean_perms(perms)})
    await users_col.update_one(
        {"_id": user["_id"]},
        {"$set": {"coHostPrefs": rows[-_CO_HOST_PREFS_LIMIT:]}},
    )
