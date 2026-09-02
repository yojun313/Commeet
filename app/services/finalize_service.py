"""Closing an event and confirming the final meeting schedule.

The host picks how many people meet at once (1 for one-on-ones), the
optimizer in `scheduling.py` proposes an assignment, the host adjusts it by
hand, and confirming locks the event and emails everyone involved.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from itertools import pairwise

from app.config import APP_NAME, BASE_URL
from app.db import event_responses_col, events_col, users_col
from app.services import calendar_service, email_service
from app.services.scheduling import assign_participants, build_slots, covers_slot


class EventNotClosable(Exception):
    pass


class InvalidMeetingLength(Exception):
    pass


class InvalidMeeting(Exception):
    pass


def _booking_by_key(finalization: dict | None) -> dict[str, tuple]:
    """참가자별 예약 상태를 (시작시각, 같은 약속의 다른 사람들)로 뽑습니다.

    두 확정본을 이 형태로 비교하면 "누구의 예약이 실제로 바뀌었는지"를
    알 수 있습니다. 같이 오는 사람 목록까지 넣는 이유는, 시간이 그대로여도
    1:1이던 약속에 다른 사람이 들어오면 그 사람에게도 달라진 약속이기
    때문입니다.
    """
    out: dict[str, tuple] = {}
    for meeting in (finalization or {}).get("meetings") or []:
        members = list(meeting.get("participants") or [])
        for key in members:
            others = tuple(sorted(k for k in members if k != key))
            out[key] = (meeting["start"], others)
    return out


def is_confirmed(event: dict) -> bool:
    return bool((event.get("finalization") or {}).get("status") == "confirmed")


def _increment(event: dict) -> int:
    return int(event.get("timeIncrement") or 15)


def validate_meeting_minutes(event: dict, meeting_minutes: int) -> None:
    """Blocks must line up with the availability grid to be checkable."""
    increment = _increment(event)
    if meeting_minutes <= 0 or meeting_minutes % increment != 0:
        raise InvalidMeetingLength(f"약속 길이는 {increment}분 단위여야 합니다.")
    window_minutes = float(event.get("duration") or 0) * 60
    if meeting_minutes > window_minutes:
        raise InvalidMeetingLength("약속 길이가 일정의 시간 범위보다 깁니다.")


async def _load_people(event: dict) -> tuple[dict | None, list[dict]]:
    """Returns (host response doc, participant descriptors).

    A participant descriptor is {key, name, email, availability, ifNeeded}.
    """
    responses = await event_responses_col.find({"eventId": event["_id"]}).to_list(
        length=None
    )
    owner_id = event.get("ownerId")
    host_key = str(owner_id) if owner_id else None

    host_response = None
    participants: list[dict] = []

    for doc in responses:
        key = doc["userId"]
        resp = doc.get("response") or {}
        if host_key and key == host_key:
            host_response = resp
            continue

        name = resp.get("name") or ""
        email = resp.get("email") or ""
        if resp.get("userId"):
            user = await users_col.find_one(
                {"_id": resp["userId"]}, {"name": 1, "email": 1}
            )
            if user:
                name = user.get("name") or name
                email = user.get("email") or email

        participants.append(
            {
                "key": key,
                "name": name or key,
                "email": email,
                "availability": set(resp.get("availability") or []),
                "ifNeeded": set(resp.get("ifNeeded") or []),
            }
        )

    participants.sort(key=lambda p: p["name"])
    return host_response, participants


async def build_proposal(
    event: dict, capacity: int, meeting_minutes: int, allow_if_needed: bool
) -> dict:
    """Runs the optimizer and returns a schedule the host can edit."""
    validate_meeting_minutes(event, meeting_minutes)

    increment = _increment(event)
    all_slots = build_slots(
        event.get("dates") or [], float(event.get("duration") or 0), meeting_minutes
    )
    host_response, participants = await _load_people(event)

    # The host attends every meeting, so drop blocks they cannot make.
    if host_response:
        host_ticks = set(host_response.get("availability") or [])
        if allow_if_needed:
            host_ticks |= set(host_response.get("ifNeeded") or [])
        usable = [
            s for s in all_slots if covers_slot(host_ticks, s[0], s[1], increment)
        ]
    else:
        usable = all_slots

    keys = [p["key"] for p in participants]
    available: dict[str, set[int]] = {}
    if_needed: dict[str, set[int]] = {}
    for p in participants:
        firm, soft = set(), set()
        for index, (start, end) in enumerate(usable):
            if covers_slot(p["availability"], start, end, increment):
                firm.add(index)
            elif allow_if_needed and covers_slot(
                p["availability"] | p["ifNeeded"], start, end, increment
            ):
                soft.add(index)
        available[p["key"]] = firm
        if_needed[p["key"]] = soft

    assignment, unassigned = assign_participants(
        keys, usable, available, if_needed, capacity
    )

    by_key = {p["key"]: p for p in participants}

    def _unassigned_reason(key: str) -> dict:
        """왜 배정되지 못했는지. 이유마다 호스트가 할 수 있는 일이 다릅니다 -
        정원을 늘릴지, 옵션을 켤지, 본인에게 다시 물어볼지."""
        person = by_key[key]
        both = person["availability"] | person["ifNeeded"]

        if not both:
            return {
                "code": "no_response",
                "text": "가능한 시간을 표시하지 않았습니다.",
            }

        if available[key] or if_needed[key]:
            # 갈 수 있는 칸은 있는데 최적화가 못 넣음 = 그 칸들이 이미 찼다는 뜻.
            return {
                "code": "capacity",
                "text": "맞는 시간이 있지만 그 시간들이 이미 정원까지 찼습니다. "
                "정원을 늘리거나 다른 사람의 배정을 옮겨 보세요.",
            }

        # 후보 블록 어디에도 못 들어감. 원인을 좁혀 봅니다.
        fits_usable = any(covers_slot(both, s, e, increment) for s, e in usable)
        if fits_usable and not allow_if_needed:
            return {
                "code": "if_needed_off",
                "text": "“가능(비선호)” 시간만 맞습니다. 위 옵션을 켜면 배정할 수 있습니다.",
            }

        if any(covers_slot(both, s, e, increment) for s, e in all_slots):
            return {
                "code": "host_busy",
                "text": "가능하다고 답한 시간에 호스트가 참석할 수 없습니다.",
            }

        return {
            "code": "too_short",
            "text": f"연속으로 {meeting_minutes}분을 비울 수 있는 시간이 없습니다.",
        }

    meetings = []
    for index in sorted(assignment):
        start, end = usable[index]
        meetings.append(
            {
                "start": start,
                "end": end,
                "participants": [
                    {"key": k, "name": by_key[k]["name"]} for k in assignment[index]
                ],
            }
        )

    return {
        "capacity": capacity,
        "meetingMinutes": meeting_minutes,
        "allowIfNeeded": allow_if_needed,
        "meetings": meetings,
        "unassigned": [
            {
                "key": k,
                "name": by_key[k]["name"],
                "reason": _unassigned_reason(k),
            }
            for k in unassigned
        ],
        "slots": [
            {
                "start": start,
                "end": end,
                "eligible": sorted(
                    (
                        p["key"]
                        for p in participants
                        if index in available[p["key"]] or index in if_needed[p["key"]]
                    ),
                ),
            }
            for index, (start, end) in enumerate(usable)
        ],
        "participants": [
            {"key": p["key"], "name": p["name"], "hasEmail": bool(p["email"])}
            for p in participants
        ],
    }


async def _sync_to_google_calendar(
    event: dict, host: dict, finalization: dict, by_key: dict
) -> list[dict]:
    """Best-effort mirror of the confirmed schedule onto Google Calendar for
    the host (who attends every meeting) and each participant who has a
    connected account. Never raises - see sync_meeting_to_account's docstring."""
    if not calendar_service.GOOGLE_CALENDAR_ENABLED:
        return []

    event_url = f"{BASE_URL}/e/{event.get('shortId') or event['_id']}"
    records: list[dict] = []

    async def push(user_doc: dict, meeting: dict, with_whom: str) -> None:
        record = await calendar_service.sync_meeting_to_account(
            user_doc,
            summary=f"[{APP_NAME}] {event.get('name') or '약속'} - {with_whom}",
            description=f"{APP_NAME}에서 확정된 약속입니다.\n{event_url}",
            start=meeting["start"],
            end=meeting["end"],
        )
        if record:
            record["userId"] = str(user_doc["_id"])
            # Kept so a later cleanup (event deletion) can tell whether this
            # meeting has already happened - see calendar_service.clear_synced_events.
            record["start"] = meeting["start"]
            record["end"] = meeting["end"]
            records.append(record)

    tasks = []
    for meeting in finalization["meetings"]:
        names = [by_key[k]["name"] for k in meeting["participants"] if k in by_key]
        tasks.append(push(host, meeting, ", ".join(names) or "참가자"))

        for key in meeting["participants"]:
            person = by_key.get(key)
            if not person:
                continue
            user_doc = await calendar_service.find_linked_user(key)
            if not user_doc or user_doc["_id"] == host["_id"]:
                continue  # already synced above - the host can also be a respondent
            other_names = [n for n in names if n != person["name"]]
            tasks.append(push(user_doc, meeting, ", ".join(other_names) or "1:1 약속"))

    await asyncio.gather(*tasks, return_exceptions=True)
    return records


async def confirm(
    event: dict, host: dict, capacity: int, meeting_minutes: int, meetings: list[dict]
) -> dict:
    """Stores the host's final schedule, closes the event and notifies people."""
    validate_meeting_minutes(event, meeting_minutes)

    _host_response, participants = await _load_people(event)
    by_key = {p["key"]: p for p in participants}

    length = timedelta(minutes=meeting_minutes)
    seen: set[str] = set()
    stored: list[dict] = []

    for meeting in meetings:
        start = meeting["start"]
        members = list(dict.fromkeys(meeting.get("participants") or []))
        if not members:
            continue
        if len(members) > capacity:
            raise InvalidMeeting(f"한 약속의 인원이 정원({capacity}명)을 초과했습니다.")
        for key in members:
            if key not in by_key:
                raise InvalidMeeting("응답자 목록에 없는 참가자가 포함되어 있습니다.")
            if key in seen:
                raise InvalidMeeting(f"{by_key[key]['name']}님이 두 번 배정되었습니다.")
            seen.add(key)
        stored.append({"start": start, "end": start + length, "participants": members})

    stored.sort(key=lambda m: m["start"])

    # The host is in every meeting, so overlapping blocks are impossible to attend.
    for earlier, later in pairwise(stored):
        if later["start"] < earlier["end"]:
            raise InvalidMeeting(
                "약속 시간이 서로 겹칩니다. 호스트는 동시에 참석할 수 없습니다."
            )

    # 지난 배정이 남아 있으면 - 확정 상태든, 확정을 취소해 둔 상태든 - 그것과
    # 비교해 **바뀐 사람에게만** 알립니다. 확정 취소는 아무에게도 알리지
    # 않으므로(cancel 참고), 취소했다가 다시 확정했을 때 시간이 그대로인
    # 사람에게 같은 안내가 한 번 더 가면 안 됩니다.
    stored_finalization = event.get("finalization") or {}
    had_assignment = bool(stored_finalization.get("meetings"))
    previous_finalization = stored_finalization if had_assignment else None
    finalization = {
        "status": "confirmed",
        "capacity": capacity,
        "meetingMinutes": meeting_minutes,
        "meetings": stored,
        "unassigned": [k for k in by_key if k not in seen],
        "confirmedAt": datetime.now(UTC),
        "confirmedBy": host["_id"],
    }

    # Clear out whatever a previous confirm() wrote to Google Calendar before
    # writing the new schedule, so re-confirming with changed assignments
    # doesn't leave stale duplicate events on anyone's real calendar.
    calendar_service.clear_synced_events_detached(
        (event.get("finalization") or {}).get("googleSyncedEvents")
    )
    finalization["googleSyncedEvents"] = await _sync_to_google_calendar(
        event, host, finalization, by_key
    )

    await events_col.update_one(
        {"_id": event["_id"]},
        {"$set": {"finalization": finalization, "isClosed": True}},
    )

    # 메일은 요청과 분리해 보냅니다 - 수십 명이면 확정 버튼이 그만큼 붙잡힙니다.
    # 화면은 "이 페이지를 나가도 계속 전송됩니다"라고 안내합니다.
    #
    # notifiedCount는 위 update_one 뒤에 붙이므로 DB에는 저장되지 않습니다.
    # 저장할 이유도 없습니다 - 방금 몇 통을 발송에 넘겼는지는 이번 응답에서만
    # 쓰는 값이고, 다음에 이 문서를 읽을 때는 의미가 없습니다.
    # 바뀐 사람에게만 보냅니다. 한 명의 시간을 옮겼는데 전원에게 "일정이
    # 변경되었습니다" 메일이 가면, 받는 사람은 자기 일정이 바뀐 줄 알고
    # 다시 확인해야 합니다.
    finalization["notifiedCount"] = _notify(
        event,
        host,
        finalization,
        by_key,
        previous=previous_finalization,
        updated=had_assignment,
    )
    return finalization


async def cancel(event: dict, host: dict) -> None:
    """확정을 풀어 응답을 다시 받습니다. **알리지 않고, 배정은 남깁니다.**

    주최자가 확정을 취소하는 것은 대개 "약속을 없던 일로 하겠다"가 아니라
    "배정을 손보겠다"입니다. 그때마다 참가자 전원에게 취소 안내가 나가면
    잠시 뒤 확정 안내가 또 나가서, 받는 쪽에서는 무슨 일이 벌어지는지
    알 수 없습니다. 그래서 여기서는 메일을 보내지 않고, 다시 확정할 때
    confirm()이 **실제로 시간이 바뀐 사람에게만** 안내합니다.

    배정(meetings)은 지우지 않고 status만 내립니다 - 확정 화면이 그대로
    불러와 이어서 고칠 수 있어야 하기 때문입니다. 지우면 처음부터 다시
    계산해야 하고, 손으로 옮겨 둔 자리가 전부 사라집니다.
    """
    finalization = event.get("finalization") or {}
    if finalization.get("status") != "confirmed":
        raise EventNotClosable("확정된 일정이 없습니다.")

    # 캘린더에 넣어 둔 약속은 지웁니다 - 확정이 풀렸는데 남아 있으면 안 됩니다.
    # 다시 확정하면 confirm()이 새로 넣습니다.
    calendar_service.clear_synced_events_detached(
        finalization.get("googleSyncedEvents")
    )

    await events_col.update_one(
        {"_id": event["_id"]},
        {
            "$set": {"isClosed": False, "finalization.status": "cancelled"},
            "$unset": {"finalization.googleSyncedEvents": ""},
        },
    )


def _notify(
    event: dict,
    host: dict,
    finalization: dict,
    by_key: dict,
    *,
    previous: dict | None = None,
    updated: bool = False,
) -> int:
    """예약이 달라진 사람에게만 안내를 보냅니다. 발송에 넘긴 통수를 반환합니다.

    `previous`가 있으면(=재확정) 이전 확정본과 비교해 **바뀐 사람만** 고릅니다.
    처음 확정할 때는 previous가 없으므로 전원에게 갑니다.

    메일 본문은 사람마다 다르므로(자기 시간, 같이 오는 사람) 한 통에 묶을 수는
    없습니다. 대신 send_many_detached()가 연결 몇 개로 나눠 동시에, 그리고
    요청과 분리해 보냅니다.
    """
    before = _booking_by_key(previous)
    after = _booking_by_key(finalization)
    mails = []

    # 확정된 전체 명단 (시간 순). 각자 자기 시간과 같은 자리에 오는 사람만
    # 알아서는 서로 시간을 바꾸기 어려워, 안내에 전체를 함께 싣습니다.
    #
    # 비공개(blind) 모드는 예외입니다 - 그 모드는 참가자끼리 서로의 응답을
    # 감추자는 것이라, 메일로 명단을 돌리면 화면에서 감춘 것이 무의미해집니다.
    roster = None
    if not event.get("blindAvailabilityEnabled"):
        roster = [
            (
                meeting["start"],
                meeting["end"],
                [by_key[k]["name"] for k in meeting["participants"] if k in by_key],
            )
            for meeting in sorted(finalization["meetings"], key=lambda m: m["start"])
        ]
        roster = [item for item in roster if item[2]]

    for meeting in finalization["meetings"]:
        names = [by_key[k]["name"] for k in meeting["participants"] if k in by_key]
        for key in meeting["participants"]:
            person = by_key.get(key)
            if not person or not person["email"]:
                continue
            # 재확정인데 이 사람의 예약이 그대로면 보내지 않습니다.
            if previous is not None and before.get(key) == after.get(key):
                continue
            mails.append(
                email_service.build_meeting_confirmed_mail(
                    person["email"],
                    host,
                    event,
                    meeting["start"],
                    meeting["end"],
                    [n for n in names if n != person["name"]],
                    # 원래 배정이 있던 사람에게만 "변경"이라고 알립니다.
                    # 새로 들어온 사람에게는 첫 확정 안내가 맞습니다.
                    updated=updated and key in before,
                    roster=roster,
                )
            )

    # People the optimizer could not place still deserve to hear the outcome.
    for key in finalization["unassigned"]:
        person = by_key.get(key)
        if not person or not person["email"]:
            continue
        # 원래도 미배정이었다면 달라진 것이 없습니다.
        if previous is not None and key not in before:
            continue
        mails.append(
            email_service.build_meeting_unassigned_mail(person["email"], host, event)
        )

    return email_service.send_many_detached(mails)
