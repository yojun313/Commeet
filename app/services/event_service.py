"""Event & response business logic - the core scheduling feature.

Mirrors timeful.app's `routes/events.go` + `db/events.go`, with these
deliberate simplifications (see project notes): no sign-up-form / "dates
only" / "specific times per day" modes, and reminder emails are sent once
(as an invite) instead of on a scheduled cadence, since there's no task
queue in this port.
"""

from datetime import UTC, datetime, timedelta

from bson import ObjectId

from app.core.ids import generate_short_id, to_object_id
from app.db import (
    event_responses_col,
    events_col,
    folder_events_col,
    meeting_records_col,
    users_col,
)
from app.schemas.event import EventPayload
from app.services import calendar_service, email_service


class NotEventOwner(Exception):
    pass


class IncrementChangeNeedsReset(Exception):
    """시간 단위를 바꾸려는데 이미 응답이 있음. 기존 응답은 옛 단위의 칸에
    찍혀 있어 새 격자와 맞지 않으므로, 주최자의 동의(reset_responses)를
    받아 지운 뒤에만 바꿉니다."""

    def __init__(self, count: int):
        self.count = count


class IncrementLockedWhileConfirmed(Exception):
    """확정된 일정의 시간 단위는 바꿀 수 없음 - 확정 배정이 응답에 기대고 있습니다."""


class NotSignedIn(Exception):
    pass


class BlindAvailabilityViolation(Exception):
    pass


class EventClosed(Exception):
    pass


class UnknownCoHosts(Exception):
    """공동주최자로 적은 이메일 중 가입한 계정이 없는 것들."""

    def __init__(self, emails: list[str]):
        self.emails = emails


# ---------------------------------------------------------------------------
# 공동주최자
# ---------------------------------------------------------------------------
#
# 주최자(ownerId)가 이메일로 지정한 가입 회원들입니다. 전체 응답 보기는 모든
# 공동주최자의 기본이고, 그 밖의 일은 사람마다 체크한 권한(coHostPerms)만큼
# 합니다. 전부 체크하면 주최자와 똑같습니다.

# 권한 이름 -> 기본값. 기본은 "운영은 같이, 일정의 존폐와 개인 기록은 주최자".
# 화면의 체크 목록(new-event.js CO_HOST_PERMS)과 같은 순서·같은 기본값입니다.
CO_HOST_PERM_DEFAULTS: dict[str, bool] = {
    "edit": True,  # 일정 정보 수정, 게스트 응답 대신 고치기
    "finalize": True,  # 최적 배정 계산·확정·확정 취소
    "mail": True,  # 초대·안내 메일 보내기
    "listed": True,  # 참가자 안내 메일·캘린더에 주최자로 이름 표시
    "notify": True,  # 응답 알림 메일 받기 (일정에서 알림을 켰을 때)
    "delete": False,  # 일정 삭제·보관·복제
    "records": False,  # 지도면담 기록 작성
    "coHosts": False,  # 공동주최자 명단·권한 바꾸기
}


def co_host_perms(event: dict, user_id) -> dict[str, bool]:
    """한 공동주최자의 권한. 저장된 값이 없는 항목은 기본값을 씁니다
    (권한 설정이 생기기 전에 지정된 공동주최자도 그대로 동작하도록)."""
    saved = (event.get("coHostPerms") or {}).get(str(user_id)) or {}
    return {k: bool(saved.get(k, v)) for k, v in CO_HOST_PERM_DEFAULTS.items()}


def is_co_host(event: dict, user: dict | None) -> bool:
    if not user or not event.get("ownerId"):
        return False
    return user["_id"] in (event.get("coHostIds") or [])


def can_manage(event: dict, user: dict | None) -> bool:
    """주최자 또는 공동주최자 - 응답 전체를 볼 수 있는가.

    주인 없는(게스트가 만든) 일정은 여기서 False입니다. 그런 일정의 "링크를
    가진 누구나 수정" 규칙은 update_event가 따로 처리합니다.
    """
    if not user or not event.get("ownerId"):
        return False
    return event["ownerId"] == user["_id"] or is_co_host(event, user)


def has_perm(event: dict, user: dict | None, perm: str) -> bool:
    """주최자는 언제나 True, 공동주최자는 체크된 권한만, 나머지는 False."""
    if not user or not event.get("ownerId"):
        return False
    if event["ownerId"] == user["_id"]:
        return True
    return is_co_host(event, user) and co_host_perms(event, user["_id"])[perm]


def my_perms(event: dict, user: dict | None) -> dict[str, bool] | None:
    """화면이 버튼을 고를 때 쓰는 내 권한. 주최자도 공동주최자도 아니면 None."""
    if not can_manage(event, user):
        return None
    return {k: has_perm(event, user, k) for k in CO_HOST_PERM_DEFAULTS}


async def resolve_co_hosts(
    entries: list, owner_id: ObjectId
) -> tuple[list[ObjectId], dict[str, dict]]:
    """공동주최자 항목(이메일 + 권한)을 (계정 id 목록, 권한 표)로 바꿉니다.

    없는 계정이 하나라도 있으면 조용히 빼지 않고 알립니다 - 빠진 줄 모르면
    그 사람은 권한이 있는 줄 알고 기다리게 됩니다. 주최자 본인은 뺍니다.
    이메일만 온 항목(예전 화면)은 기본 권한을 받습니다.
    """
    perms_by_email: dict[str, dict] = {}
    for entry in entries:
        email = entry if isinstance(entry, str) else entry.email
        email = (email or "").strip().lower()
        if not email or email in perms_by_email:
            continue
        given = {} if isinstance(entry, str) else (entry.perms or {})
        perms_by_email[email] = {
            k: bool(given.get(k, v)) for k, v in CO_HOST_PERM_DEFAULTS.items()
        }
    if not perms_by_email:
        return [], {}

    wanted = list(perms_by_email)
    docs = await users_col.find({"email": {"$in": wanted}}, {"email": 1}).to_list(
        length=None
    )
    by_email = {d["email"].lower(): d["_id"] for d in docs}
    missing = [e for e in wanted if e not in by_email]
    if missing:
        raise UnknownCoHosts(missing)
    ids = [by_email[e] for e in wanted if by_email[e] != owner_id]
    perms = {
        str(by_email[e]): perms_by_email[e] for e in wanted if by_email[e] != owner_id
    }
    return ids, perms


async def co_host_list(event: dict) -> list[dict]:
    """화면용 공동주최자 명단 (지정한 순서 그대로, 권한 포함). 탈퇴한 계정은 뺍니다."""
    ids = event.get("coHostIds") or []
    if not ids:
        return []
    docs = await users_col.find({"_id": {"$in": ids}}, {"name": 1, "email": 1}).to_list(
        length=None
    )
    by_id = {d["_id"]: d for d in docs}
    return [
        {
            "_id": str(i),
            "name": (by_id[i].get("name") or "").strip(),
            "email": by_id[i].get("email", ""),
            "perms": co_host_perms(event, i),
        }
        for i in ids
        if i in by_id
    ]


async def notify_recipients(event: dict, owner: dict | None) -> list[dict]:
    """응답 알림을 받을 사람 - 주최자와 "응답 알림" 권한을 받은 공동주최자."""
    people = [owner] if owner else []
    ids = [
        i for i in (event.get("coHostIds") or []) if co_host_perms(event, i)["notify"]
    ]
    if ids:
        people += await users_col.find({"_id": {"$in": ids}}).to_list(length=None)
    return people


async def host_label(event: dict) -> str:
    """참가자에게 보이는 주최자 이름 - 주최자와 "이름 표시" 권한의 공동주최자.

    예: "김교수, 이조교". 안내 메일의 보낸 사람·본문, 캘린더 초대의 주최자
    칸에 그대로 들어갑니다. 주최자가 앞, 공동주최자는 지정한 순서입니다.
    """
    names: list[str] = []
    ids = [event["ownerId"]] if event.get("ownerId") else []
    ids += [
        i for i in (event.get("coHostIds") or []) if co_host_perms(event, i)["listed"]
    ]
    if ids:
        docs = await users_col.find(
            {"_id": {"$in": ids}}, {"name": 1, "email": 1}
        ).to_list(length=None)
        by_id = {
            d["_id"]: (d.get("name") or d.get("email") or "").strip() for d in docs
        }
        names = [by_id[i] for i in ids if by_id.get(i)]
    return ", ".join(dict.fromkeys(names))


async def as_hosts(event: dict, actor: dict | None) -> dict | None:
    """메일·캘린더에 넘길 "주최자" 문서. 실제로 보내는 사람(actor)의 문서를
    그대로 쓰되(참조 주소, 캘린더 계정) 이름만 주최자 모두의 이름으로 바꿉니다.
    원본을 고치지 않도록 사본을 돌려줍니다."""
    if not actor or not event.get("ownerId"):
        return actor
    label = await host_label(event)
    return {**actor, "name": label} if label else actor


def professor_features(user: dict | None) -> bool:
    """계정에 "교수용 기능"(지도학생 면담 관리)을 켰는가.

    가입할 때 고르고 계정 설정에서 바꿉니다. 값이 없는 계정(이 설정이
    생기기 전에 가입한 계정)은 꺼진 것으로 봅니다. 꺼 두어도 이미 적은
    기록은 지우지 않습니다 - 다시 켜면 그대로 보입니다.
    """
    return bool((user or {}).get("professorFeatures"))


def records_enabled(event: dict) -> bool:
    """이 일정에서 "면담 기록 · 학생지도비"를 쓰는가.

    값이 **없는** 일정은 켜진 것으로 봅니다. 이 항목이 생기기 전에 만든
    일정에도 이미 적어 둔 기록이 있는데, 없다고 꺼 버리면 그 기록에 닿을
    길이 사라집니다. 새로 만드는 일정은 항상 True/False가 명시됩니다.

    화면 쪽 같은 규칙은 event-grid.js의 recordsEnabled()입니다.
    """
    return event.get("guidanceRecordsEnabled") is not False


def is_past_event(event: dict) -> bool:
    """이 일정의 마지막 시간이 이미 지났는지.

    지난 일정을 없애는 건 "취소"가 아니라 기록을 "삭제"하는 일이고,
    앞으로 있을 일정을 없애는 건 참가자에게 "취소"입니다. 안내 문구가
    달라야 해서 구분합니다.

    """
    dates = [d for d in (event.get("dates") or []) if isinstance(d, datetime)]
    if not dates:
        return False

    last_end = max(dates) + timedelta(hours=float(event.get("duration") or 0))
    if last_end.tzinfo is None:
        last_end = last_end.replace(tzinfo=UTC)
    return last_end < datetime.now(UTC)


def removal_word(event: dict) -> str:
    """지난 일정이면 "삭제", 앞으로의 일정이면 "취소"."""
    return "삭제" if is_past_event(event) else "취소"


def is_closed(event: dict) -> bool:
    """A confirmed schedule freezes responses until the host cancels it."""
    return bool(event.get("isClosed"))


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


async def get_removed_event(event_id: str) -> dict | None:
    """휴지통에 있는(soft-deleted) 일정을 id로 찾습니다.

    일반 조회는 isDeleted를 걸러 내므로 링크를 누른 참가자에게는 그냥 404가
    떴습니다. "취소되었습니다"라고 알려 주려면 지워진 문서도 볼 수 있어야
    합니다. 이름과 주최자만 쓰고 응답 내용은 노출하지 않습니다.
    """
    if len(event_id) <= 10:
        return await events_col.find_one({"shortId": event_id, "isDeleted": True})
    oid = to_object_id(event_id)
    return await events_col.find_one({"_id": oid, "isDeleted": True}) if oid else None


async def get_event_by_either_id(event_id: str) -> dict | None:
    """Event links use either the Mongo _id or the short, shareable id."""
    if len(event_id) <= 10:
        return await get_event_by_short_id(event_id)
    return await get_event_by_id(event_id)


# --------------------------------------------------------------------- #
# 화면 자동 갱신용 버전 카운터                                             #
# --------------------------------------------------------------------- #
#
# 일정 페이지는 다른 참가자가 시간을 찍으면 자동으로 반영돼야 합니다.
# 그렇다고 응답 전체(/responses는 응답자 한 명당 ISO 문자열 수백 개)를
# 몇 초마다 다시 받으면 트래픽이 감당이 안 됩니다.
#
# 그래서 "바뀌었나?"와 "데이터 줘"를 나눕니다. 이벤트 문서에 정수 `v`를
# 하나 두고 **변경이 일어날 때마다 1씩 올립니다**. 화면은 `v`만 폴링하다가
# (한 번에 _id 인덱스 조회 1회 + 수십 바이트) 값이 달라졌을 때만 무거운
# 조회를 합니다.
#
# `v`를 올리는 곳은 app.main의 bump_event_version_middleware 한 곳뿐입니다 -
# 응답 저장/삭제/이름변경/거절/일정수정/초대/확정 등 쓰기 경로가 서른 군데
# 가까이 흩어져 있어서, 한 군데씩 넣으면 반드시 빠뜨리기 때문입니다.


def either_id_query(event_id: str) -> dict | None:
    """`get_event_by_either_id`와 같은 판별 규칙의 **필터만** 만듭니다.

    버전을 읽거나 올릴 때는 문서 본문이 필요 없으므로, 조회를 한 번 더
    하지 않고 이 필터로 바로 질의합니다.
    """
    if len(event_id) <= 10:
        return {"shortId": event_id, "isDeleted": {"$ne": True}}
    oid = to_object_id(event_id)
    return {"_id": oid, "isDeleted": {"$ne": True}} if oid else None


async def get_version(event_id: str) -> int | None:
    """일정의 현재 버전. 없거나 지워진 일정이면 None."""
    query = either_id_query(event_id)
    if query is None:
        return None
    doc = await events_col.find_one(query, {"v": 1})
    if doc is None:
        return None
    return int(doc.get("v") or 0)


async def bump_version(event_id: str) -> None:
    """화면에 보이는 내용이 바뀌었다고 표시합니다.

    `v`가 없던 기존 문서에도 $inc가 그대로 동작합니다(0에서 시작).
    """
    query = either_id_query(event_id)
    if query is None:
        return
    await events_col.update_one(query, {"$inc": {"v": 1}})


async def get_event_responses(event_id: ObjectId) -> list[dict]:
    return await event_responses_col.find({"eventId": event_id}).to_list(length=None)


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
    # 저장 전에 확인합니다 - 없는 계정이 섞여 있으면 일정을 만들지 않고
    # 화면에서 고치게 합니다 (만들어진 뒤에 알리면 일정이 두 번 생깁니다).
    co_host_ids, co_host_perms_map = (
        await resolve_co_hosts(payload.coHosts, owner["_id"])
        if owner and payload.coHosts
        else ([], {})
    )
    event = {
        "ownerId": owner["_id"] if owner else None,
        "coHostIds": co_host_ids,
        "coHostPerms": co_host_perms_map,
        "name": payload.name,
        "description": payload.description,
        "descriptionFormat": payload.descriptionFormat,
        "isArchived": False,
        "isDeleted": False,
        "duration": payload.duration,
        "dates": payload.dates,
        "startOnMonday": payload.startOnMonday,
        "notificationsEnabled": payload.notificationsEnabled,
        "blindAvailabilityEnabled": payload.blindAvailabilityEnabled,
        "collectEmails": payload.collectEmails,
        # 교수용 기능을 안 켠 계정의 화면에는 이 체크가 없습니다.
        "guidanceRecordsEnabled": payload.guidanceRecordsEnabled
        and professor_features(owner),
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

    remindees = [{"email": email, "responded": False} for email in payload.remindees]
    if remindees:
        await events_col.update_one(
            {"_id": event["_id"]}, {"$set": {"remindees": remindees}}
        )
        event["remindees"] = remindees

    # 만들자마자 초대 메일을 보내지 않습니다.
    #
    # 예전에는 여기서 바로 보냈는데, 주최자는 보통 일정을 만든 **다음에**
    # 자기 가능한 시간을 찍습니다. 그 사이에 메일을 받은 사람들이 링크를 열면
    # 아무도 표시하지 않은 빈 화면이 나와서 "이걸 왜 보냈지?" 하게 됩니다.
    #
    # 그래서 발송은 주최자가 처음 가능한 시간을 저장한 뒤로 미룹니다 -
    # 그때 화면이 초대할지 묻고, /api/events/{id}/invite로 보냅니다
    # (event-grid.js의 maybeOfferInvite). 여기서 받은 명단은 저장만 해 둡니다.
    event["invitesQueued"] = 0

    if owner:
        await users_col.update_one(
            {"_id": owner["_id"]}, {"$inc": {"numEventsCreated": 1}}
        )

    return event


async def update_event(
    event: dict,
    payload: EventPayload,
    requester: dict | None,
    *,
    reset_responses: bool = False,
) -> dict:
    owner_id = event.get("ownerId")
    requester_id = requester["_id"] if requester else None
    if owner_id is not None and not has_perm(event, requester, "edit"):
        raise NotEventOwner()

    # 공동주최자 명단·권한은 주최자와 "공동주최자 관리" 권한을 받은 사람만
    # 바꿉니다. 그 밖의 공동주최자가 저장한 요청에 명단이 실려 와도 무시합니다.
    co_host_update = None
    if (
        owner_id is not None
        and payload.coHosts is not None
        and has_perm(event, requester, "coHosts")
    ):
        co_host_update = await resolve_co_hosts(payload.coHosts, owner_id)

    # 시간 단위 변경. 예전에는 저장 대상에 아예 없어 조용히 무시됐습니다.
    increment_changed = int(event.get("timeIncrement") or 15) != payload.timeIncrement
    if increment_changed:
        if event.get("isClosed"):
            raise IncrementLockedWhileConfirmed()
        count = await event_responses_col.count_documents({"eventId": event["_id"]})
        if count and not reset_responses:
            raise IncrementChangeNeedsReset(count)

    updates = {
        "name": payload.name,
        "description": payload.description,
        "descriptionFormat": payload.descriptionFormat,
        "duration": payload.duration,
        "dates": payload.dates,
        "startOnMonday": payload.startOnMonday,
        "notificationsEnabled": payload.notificationsEnabled,
        "blindAvailabilityEnabled": payload.blindAvailabilityEnabled,
        "collectEmails": payload.collectEmails,
        "sendEmailAfterXResponses": payload.sendEmailAfterXResponses,
        "type": payload.type.value,
        "timeIncrement": payload.timeIncrement,
    }
    # 교수용 기능을 안 켠 사람의 수정 창에는 이 체크가 없어 늘 False가
    # 옵니다 - 그대로 저장하면 다른 주최자가 켜 둔 기능이 꺼집니다.
    if professor_features(requester):
        updates["guidanceRecordsEnabled"] = payload.guidanceRecordsEnabled
    if co_host_update is not None:
        updates["coHostIds"], updates["coHostPerms"] = co_host_update

    unset: dict = {}
    if increment_changed:
        # 옛 단위로 찍힌 응답과, 그 응답을 기준으로 저장해 둔 (확정 취소된)
        # 배정 초안을 함께 지웁니다 - 남겨 두면 없는 칸·없는 사람을 가리킵니다.
        await event_responses_col.delete_many({"eventId": event["_id"]})
        unset["finalization"] = ""

    old_remindees = {r["email"]: r for r in event.get("remindees") or []}
    new_remindee_emails = set(payload.remindees)
    kept_emails = set(old_remindees) & new_remindee_emails
    added_emails = new_remindee_emails - set(old_remindees)

    updated_remindees = [old_remindees[email] for email in kept_emails]
    for email in added_emails:
        updated_remindees.append({"email": email, "responded": False})
    presenter = await as_hosts(event, requester) if added_emails else requester
    queued = email_service.send_many_detached(
        [
            email_service.build_event_invite_mail(email, presenter, event)
            for email in added_emails
        ]
    )

    if increment_changed:
        # 응답이 지워졌으니 "응답함" 표시도 되돌려 리마인더 대상에 다시 넣습니다.
        updated_remindees = [{**r, "responded": False} for r in updated_remindees]
    updates["remindees"] = updated_remindees

    update_doc: dict = {"$set": updates}
    if unset:
        update_doc["$unset"] = unset
    await events_col.update_one({"_id": event["_id"]}, update_doc)
    saved = await events_col.find_one({"_id": event["_id"]})
    saved["invitesQueued"] = queued
    return saved


async def _cancellation_recipients(event: dict, owner: dict) -> list[str]:
    """일정 취소 안내를 받아야 할 이메일 목록.

    응답한 사람 전원 (주최자 본인은 제외).
    주최자 본인은 뺍니다 - 본인이 취소한 것이니 알릴 이유가 없습니다.
    """
    from app.services.finalize_service import _load_people

    _host, people = await _load_people(event)
    owner_email = (owner.get("email") or "").lower()
    seen: set[str] = set()
    emails: list[str] = []

    for person in people:
        email = (person.get("email") or "").lower()
        if email and email != owner_email and email not in seen:
            seen.add(email)
            emails.append(person["email"])

    return emails


async def mail_targets(event: dict, owner: dict) -> dict:
    """주최자가 메일을 보낼 수 있는 사람들. 응답 여부로 나눠 돌려줍니다.

    응답한 사람은 응답 기록에서, 아직 안 한 사람은 초대 명단(remindees)에서
    가져옵니다 - 초대는 보냈지만 응답이 없는 사람이 리마인더의 대상입니다.

    이메일을 모르는 사람도 목록에는 넣되 email을 비워 둡니다. 조용히 빼면
    주최자는 "왜 이 사람은 안 보이지" 하게 되고, 게스트가 이메일을 남기지
    않았다는 사실 자체를 알 방법이 없습니다.
    """
    from app.services.finalize_service import _load_people

    _host, people = await _load_people(event)
    owner_email = (owner.get("email") or "").lower()

    responded = []
    responded_emails: set[str] = set()
    for person in people:
        email = (person.get("email") or "").strip()
        if email.lower() == owner_email:
            continue  # 주최자 본인에게 보낼 이유가 없습니다
        if email:
            responded_emails.add(email.lower())
        responded.append({"name": person.get("name") or email, "email": email})

    pending_emails = []
    for entry in event.get("remindees") or []:
        email = (entry.get("email") or "").strip()
        if not email:
            continue
        low = email.lower()
        if low == owner_email or low in responded_emails:
            continue
        pending_emails.append(email)

    # 아직 응답하지 않은 사람은 응답 기록에 이름이 없으므로, 주최자의
    # 연락처(초대할 때 거의 항상 등록되어 있음)와 가입 계정에서 이름을
    # 찾습니다. 둘 다 없으면 이메일 **전체**를 보여 줍니다 - 앞부분만 잘라
    # 보여 주면 이름처럼 보여서, 진짜 이름과 구별이 안 됩니다.
    names: dict[str, str] = {}
    if pending_emails:
        from app.db import contacts_col, users_col

        async for c in contacts_col.find(
            {"ownerId": owner["_id"], "email": {"$in": pending_emails}},
            {"email": 1, "name": 1},
        ):
            if c.get("name"):
                names[c["email"].lower()] = c["name"]
        async for u in users_col.find(
            {"email": {"$in": pending_emails}}, {"email": 1, "name": 1}
        ):
            names.setdefault(u["email"].lower(), u.get("name") or "")

    pending = [
        {"name": names.get(email.lower()) or email, "email": email}
        for email in pending_emails
    ]

    return {"responded": responded, "pending": pending}


async def remember_invitees(event: dict, emails: list[str]) -> None:
    """초대한 사람을 일정에 적어 둡니다.

    적어 두지 않으면 "초대는 받았는데 아직 응답하지 않은 사람"을 알 수 없어
    리마인더를 보낼 대상을 고를 수 없습니다 (mail_targets). 이미 있는 주소는
    그대로 둡니다.
    """
    existing = {(r.get("email") or "").lower() for r in (event.get("remindees") or [])}
    added = [
        {"email": email, "responded": False}
        for email in dict.fromkeys(e.strip() for e in emails if e and e.strip())
        if email.lower() not in existing
    ]
    if not added:
        return
    await events_col.update_one(
        {"_id": event["_id"]}, {"$push": {"remindees": {"$each": added}}}
    )


async def delete_event(
    event: dict, requester: dict, *, notify: bool = True, presenter: dict | None = None
) -> int:
    """일정을 삭제하고, 참가자에게 취소 안내를 보낸 통수를 반환합니다.

    남이 응답한 일정은 그 응답을 지우지 않으려고 숨김 처리(휴지통)만 하는데,
    참가자 입장에서는 어느 쪽이든 "이 일정은 없어졌다"가 되므로 안내는
    똑같이 나갑니다.
    """
    notified = 0
    if notify:
        # requester는 주최자(공동주최자가 지워도 주최자 기준), presenter는
        # 안내에 이름이 나갈 사람들 - 없으면 주최자 모두의 이름을 씁니다.
        presenter = presenter or await as_hosts(event, requester)
        actor_email = (presenter.get("email") or "").lower()
        word = removal_word(event)
        recipients = [
            e
            for e in await _cancellation_recipients(event, requester)
            if e.lower() != actor_email
        ]
        notified = email_service.send_many_detached(
            [
                email_service.build_event_cancelled_mail(
                    email, presenter, event, word=word
                )
                for email in recipients
            ]
        )

    responses = await get_event_responses(event["_id"])
    has_other_responses = any(r["userId"] != str(requester["_id"]) for r in responses)

    # A confirmed schedule may have mirrored meetings onto people's real
    # Google Calendars (see finalize_service.confirm) - those live outside
    # this DB entirely, so deleting/hiding the event doesn't clean them up
    # on its own. A meeting that already happened is left alone (it's real
    # history at that point); only meetings still in the future are removed,
    # since deleting the room means they're no longer actually happening.
    synced = (event.get("finalization") or {}).get("googleSyncedEvents")

    if has_other_responses:
        # Someone else already responded - keep their data, just hide the event.
        update: dict = {"isDeleted": True}
        if synced is not None:
            update["finalization.googleSyncedEvents"] = (
                calendar_service.clear_synced_events_detached(synced, only_future=True)
            )
        await events_col.update_one({"_id": event["_id"]}, {"$set": update})
    else:
        calendar_service.clear_synced_events_detached(synced, only_future=True)
        await events_col.delete_one({"_id": event["_id"]})
        await event_responses_col.delete_many({"eventId": event["_id"]})
        await folder_events_col.delete_many({"eventId": event["_id"]})

    return notified


async def list_deleted_events(user: dict) -> list[dict]:
    """휴지통 목록. 남이 응답한 일정을 지우면 완전히 없애지 않고 숨기는데
    (delete_event 참고), 그렇게 숨겨진 내 일정을 여기서 다시 봅니다."""
    events = (
        await events_col.find({"ownerId": user["_id"], "isDeleted": True})
        .sort("_id", -1)
        .to_list(length=None)
    )
    for event in events:
        event["numResponses"] = await event_responses_col.count_documents(
            {"eventId": event["_id"]}
        )
        event["numRecords"] = await meeting_records_col.count_documents(
            {"ownerId": user["_id"], "eventId": event["_id"]}
        )
        # 화면에서 "취소됨 / 삭제됨"을 구분해 보여 주기 위한 값.
        event["removalWord"] = removal_word(event)
        event["isPast"] = is_past_event(event)
    return events


async def restore_event(event: dict, owner: dict, *, notify: bool = False) -> int:
    """휴지통에서 되돌리고, 보낸 안내 통수를 반환합니다.

    삭제할 때 "취소되었습니다"를 받은 사람들에게는 그 안내를 정정해 줘야
    하므로, 되돌릴 때도 알릴 수 있게 해 둡니다.
    """
    await events_col.update_one({"_id": event["_id"]}, {"$set": {"isDeleted": False}})
    if not notify:
        return 0
    recipients = await _cancellation_recipients(event, owner)
    presenter = await as_hosts(event, owner)
    return email_service.send_many_detached(
        [
            email_service.build_event_reopened_mail(email, presenter, event)
            for email in recipients
        ]
    )


async def purge_event(event: dict, owner: dict) -> dict:
    """일정과 딸린 데이터를 DB에서 완전히 지웁니다. 되돌릴 수 없습니다.

    면담 기록은 암호화된 첨부(서명·영수증)를 디스크에도 남기므로, 문서를
    지우기 전에 파일부터 지웁니다 - 순서가 반대면 파일 경로를 알 방법이
    없어져 고아 파일이 남습니다.

    구글 캘린더는 건드리지 않습니다. 이미 delete_event()가 앞으로의 약속만
    지웠고, 지난 약속은 실제로 있었던 일이라 남겨 두는 편이 맞습니다.
    """
    from app.services import crypto_service

    event_id = event["_id"]
    records = await meeting_records_col.find(
        {"ownerId": owner["_id"], "eventId": event_id}, {"_id": 1}
    ).to_list(length=None)
    for record in records:
        crypto_service.delete_record_files(str(record["_id"]))

    removed = {
        "records": (
            await meeting_records_col.delete_many(
                {"ownerId": owner["_id"], "eventId": event_id}
            )
        ).deleted_count,
        "responses": (
            await event_responses_col.delete_many({"eventId": event_id})
        ).deleted_count,
        "folderLinks": (
            await folder_events_col.delete_many({"eventId": event_id})
        ).deleted_count,
    }
    await events_col.delete_one({"_id": event_id})
    return removed


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
        # "v"는 갱신 카운터라 원본 것을 물려받을 이유가 없습니다 (0에서 시작).
        if k not in {"_id", "shortId", "numResponses", "remindees", "createdAt", "v"}
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

    return new_event


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------


async def upsert_response(
    event: dict, payload, requester: dict | None
) -> tuple[bool, str]:
    """Returns (is_new_response, user_key)."""
    if is_closed(event):
        raise EventClosed()
    if event.get("blindAvailabilityEnabled") and requester and payload.guest:
        if not has_perm(event, requester, "edit"):
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
    if is_closed(event):
        raise EventClosed()
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
        if target != user_key and not has_perm(event, requester, "edit"):
            raise NotEventOwner()

        result = await event_responses_col.delete_one(
            {"eventId": event["_id"], "userId": target}
        )

    if result.deleted_count:
        await events_col.update_one(
            {"_id": event["_id"]}, {"$inc": {"numResponses": -1}}
        )


# ---------------------------------------------------------------------------
# Response shaping / privacy
# ---------------------------------------------------------------------------


async def _decorate_response(
    doc: dict, *, show_emails: bool, include_availability: bool
) -> dict | None:
    resp = dict(doc["response"])
    user_oid = resp.get("userId")

    if user_oid:
        user = await users_col.find_one({"_id": user_oid})
        if user is None:
            return None  # account was deleted
        resp["user"] = {
            "_id": str(user["_id"]),
            "name": user.get("name", ""),
            "picture": user.get("picture", ""),
            "email": user.get("email", "") if show_emails else "",
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
    result: dict[str, dict] = {}
    for doc in responses:
        decorated = await _decorate_response(
            doc,
            show_emails=show_emails,
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
    """비공개 일정에서 남에게 보여 줄 응답만 남깁니다.

    숨기는 대상은 **참가자끼리의 응답**입니다 - 서로 보고 따라 적는 것을
    막자는 옵션이니까요. **주최자의 응답은 남깁니다**: 응답자는 주최자와
    겹치는 시간을 골라야 하므로 그 시간이 보여야 하고, 이 옵션을 켠 것도
    주최자 본인입니다. (편집 화면의 "주최자 가능" 점이 여기서 나옵니다.)
    """
    if not event.get("blindAvailabilityEnabled") or is_owner:
        return responses_map

    kept: dict = {}
    owner_key = str(event["ownerId"]) if event.get("ownerId") else None
    if owner_key and owner_key in responses_map:
        kept[owner_key] = responses_map[owner_key]

    if viewer:
        key = str(viewer["_id"])
        if key in responses_map:
            kept[key] = responses_map[key]
    elif guest_name and guest_name in responses_map:
        kept[guest_name] = responses_map[guest_name]
    return kept


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
