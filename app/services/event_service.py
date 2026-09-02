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


class NotSignedIn(Exception):
    pass


class BlindAvailabilityViolation(Exception):
    pass


class EventClosed(Exception):
    pass


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
    event = {
        "ownerId": owner["_id"] if owner else None,
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
        "guidanceRecordsEnabled": payload.guidanceRecordsEnabled,
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
    event: dict, payload: EventPayload, requester: dict | None
) -> dict:
    owner_id = event.get("ownerId")
    requester_id = requester["_id"] if requester else None
    if owner_id is not None and owner_id != requester_id:
        raise NotEventOwner()

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
        "guidanceRecordsEnabled": payload.guidanceRecordsEnabled,
        "sendEmailAfterXResponses": payload.sendEmailAfterXResponses,
        "type": payload.type.value,
    }

    old_remindees = {r["email"]: r for r in event.get("remindees") or []}
    new_remindee_emails = set(payload.remindees)
    kept_emails = set(old_remindees) & new_remindee_emails
    added_emails = new_remindee_emails - set(old_remindees)

    updated_remindees = [old_remindees[email] for email in kept_emails]
    for email in added_emails:
        updated_remindees.append({"email": email, "responded": False})
    queued = email_service.send_many_detached(
        [
            email_service.build_event_invite_mail(email, requester, event)
            for email in added_emails
        ]
    )

    updates["remindees"] = updated_remindees

    await events_col.update_one({"_id": event["_id"]}, {"$set": updates})
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

    pending = []
    for entry in event.get("remindees") or []:
        email = (entry.get("email") or "").strip()
        if not email:
            continue
        low = email.lower()
        if low == owner_email or low in responded_emails:
            continue
        pending.append({"name": email.split("@")[0], "email": email})

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


async def delete_event(event: dict, requester: dict, *, notify: bool = True) -> int:
    """일정을 삭제하고, 참가자에게 취소 안내를 보낸 통수를 반환합니다.

    남이 응답한 일정은 그 응답을 지우지 않으려고 숨김 처리(휴지통)만 하는데,
    참가자 입장에서는 어느 쪽이든 "이 일정은 없어졌다"가 되므로 안내는
    똑같이 나갑니다.
    """
    notified = 0
    if notify:
        word = removal_word(event)
        recipients = await _cancellation_recipients(event, requester)
        notified = email_service.send_many_detached(
            [
                email_service.build_event_cancelled_mail(
                    email, requester, event, word=word
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
    return email_service.send_many_detached(
        [
            email_service.build_event_reopened_mail(email, owner, event)
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
        owner_id = event.get("ownerId")
        if target != user_key and owner_id != requester["_id"]:
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
