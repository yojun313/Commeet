from datetime import datetime

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request, status

from app.config import ALLOWED_EMAIL_DOMAIN, RESTRICT_TO_POSTECH
from app.core import ratelimit
from app.core.clientip import get_client_ip, is_postech_request
from app.core.ids import to_object_id
from app.core.serialize import jsonable
from app.db import events_col
from app.schemas.event import (
    DeleteResponsePayload,
    DuplicateEventPayload,
    EventPayload,
    EventResponsePayload,
    RenameGuestPayload,
    SendInvitePayload,
    SendMessagePayload,
)
from app.services import email_service, event_service
from app.services.auth_service import get_optional_user, get_user_by_id, require_user

router = APIRouter(prefix="/api/events", tags=["events"])


def _require_member_to_create(request: Request, user: dict | None) -> None:
    """외부인의 일정 생성을 막습니다 (RESTRICT_TO_POSTECH).

    응답·수정은 그대로 둡니다 - 외부 참가자가 초대받은 일정에 시간을 적는
    것이 이 서비스의 핵심 흐름이라서요. 막는 것은 "새 일정을 만드는 것"
    뿐입니다.
    """
    if not RESTRICT_TO_POSTECH:
        return
    if is_postech_request(request, user, domain=ALLOWED_EMAIL_DOMAIN):
        return
    raise HTTPException(
        status_code=403,
        detail=f"교내 네트워크 또는 @{ALLOWED_EMAIL_DOMAIN} 계정으로 로그인해야 "
        "일정을 만들 수 있습니다. 초대받은 일정에는 그대로 응답할 수 있습니다.",
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_event(payload: EventPayload, request: Request):
    owner = await get_optional_user(request)
    _require_member_to_create(request, owner)
    event = await event_service.create_event(payload, owner)
    return {
        "eventId": str(event["_id"]),
        "shortId": event.get("shortId"),
        # 초대 메일은 백그라운드로 나갑니다. 화면이 "보내는 중"이라고 알릴 수
        # 있도록 넘긴 통수를 함께 돌려줍니다.
        "invitesQueued": event.get("invitesQueued", 0),
    }


@router.put("/{event_id}")
async def edit_event(
    event_id: str,
    payload: EventPayload,
    request: Request,
    resetResponses: bool = False,
):
    """`resetResponses=true`: 시간 단위를 바꾸면서 기존 응답을 지우는 데
    주최자가 동의했다는 뜻 (화면이 409를 받고 확인 창을 거친 뒤 다시 보냄)."""
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    requester = await get_optional_user(request)
    try:
        saved = await event_service.update_event(
            event, payload, requester, reset_responses=resetResponses
        )
    except event_service.NotEventOwner as exc:
        raise HTTPException(
            status_code=403, detail="이 이벤트를 수정할 권한이 없습니다"
        ) from exc
    except event_service.IncrementLockedWhileConfirmed as exc:
        raise HTTPException(
            status_code=400,
            detail="확정된 일정은 시간 단위를 바꿀 수 없습니다. 확정을 취소한 뒤 바꿔 주세요.",
        ) from exc
    except event_service.IncrementChangeNeedsReset as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "increment_reset_required", "responses": exc.count},
        ) from exc

    return {"invitesQueued": saved.get("invitesQueued", 0)}


@router.get("/{event_id}/ids")
async def get_event_ids(event_id: str):
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    return {"shortId": event.get("shortId") or "", "longId": str(event["_id"])}


@router.get("/{event_id}/version")
async def get_event_version(event_id: str):
    """화면이 몇 초마다 두드리는 **가장 싼** 엔드포인트.

    응답은 `{"v": 12}` 뿐이고, 인증도 하지 않습니다 - 링크 자체가 비밀이고
    "무언가 바뀌었다"는 사실만으로는 아무 내용도 새어 나가지 않으므로,
    쿠키에서 사용자를 찾는 조회 한 번까지 아낍니다. 결과적으로 폴링 1회당
    인덱스 조회 정확히 1번입니다.

    지워진 일정은 404를 돌려주어, 보고 있던 화면이 폴링을 멈출 수 있게
    합니다 (event-grid.js의 liveTick).
    """
    version = await event_service.get_version(event_id)
    if version is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    return {"v": version}


@router.get("/{event_id}")
async def get_event(event_id: str, request: Request, guestName: str | None = None):
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    viewer = await get_optional_user(request)
    is_owner = bool(viewer) and event.get("ownerId") == viewer["_id"]

    responses = await event_service.get_event_responses(event["_id"])
    responses_map = await event_service.build_responses_map(
        event, responses, is_owner=is_owner, include_availability=False
    )

    result = dict(event)
    result["responses"] = event_service.apply_blind_filter(
        event, responses_map, viewer=viewer, is_owner=is_owner, guest_name=guestName
    )
    result["isOwner"] = is_owner
    result["isClosed"] = bool(event.get("isClosed"))

    if is_owner:
        # 사이드바의 "미응답" 섹션용. 초대는 받았는데 아직 응답하지 않은
        # 사람들 - "메일 보내기"가 쓰는 것과 같은 계산(mail_targets)이라
        # 리마인더 대상과 화면 목록이 어긋나지 않습니다. 초대 이메일이
        # 드러나므로 주최자에게만 내려 줍니다.
        targets = await event_service.mail_targets(event, viewer)
        result["pendingInvitees"] = targets["pending"]

    if not is_owner:
        # 초대 명단은 이메일 목록입니다 - 링크만 가진 사람에게 다른
        # 초대자들의 이메일을 보여 줄 이유가 없습니다. 화면에서도 이 값은
        # 주최자만 씁니다 (초대 권유 배너).
        result["remindees"] = None

    if event.get("blindAvailabilityEnabled") and not is_owner:
        result["numResponses"] = None

    return jsonable(result)


@router.get("/{event_id}/responses")
async def get_responses(
    event_id: str,
    request: Request,
    timeMin: datetime,
    timeMax: datetime,
    guestName: str | None = None,
):
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    viewer = await get_optional_user(request)
    is_owner = bool(viewer) and event.get("ownerId") == viewer["_id"]

    responses_map = await event_service.get_filtered_responses_map(
        event, timeMin, timeMax, is_owner=is_owner
    )
    responses_map = event_service.apply_blind_filter(
        event, responses_map, viewer=viewer, is_owner=is_owner, guest_name=guestName
    )
    return jsonable(responses_map)


def _limit_link_writes(request: Request, bucket: str, *, limit: int) -> None:
    """링크만 알면 되는 쓰기(게스트 응답·이름 변경)의 IP당 속도 제한.

    링크가 곧 권한인 설계라 인증으로는 못 막고, 정상 사용자는 몇 분에
    몇 번이면 충분합니다 - 한 IP가 기계적으로 응답을 쌓아 일정을 쓰레기로
    채우는 것만 걸러냅니다.
    """
    ip = get_client_ip(request) or "?"
    if not ratelimit.allow(f"{bucket}:{ip}", limit=limit, per_seconds=300):
        raise HTTPException(
            status_code=429,
            detail="요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.",
        )


@router.post("/{event_id}/response")
async def update_event_response(
    event_id: str, payload: EventResponsePayload, request: Request
):
    _limit_link_writes(request, "response", limit=60)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    requester = await get_optional_user(request)

    try:
        is_new, user_key = await event_service.upsert_response(
            event, payload, requester
        )
    except event_service.BlindAvailabilityViolation as exc:
        raise HTTPException(
            status_code=403,
            detail="비공개 모드에서는 게스트 응답을 대신 등록할 수 없습니다",
        ) from exc
    except event_service.EventClosed as exc:
        raise HTTPException(
            status_code=409, detail="일정이 확정되어 더 이상 응답을 수정할 수 없습니다"
        ) from exc
    except event_service.NotSignedIn as exc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    owner_id = event.get("ownerId")
    if is_new and owner_id and user_key != str(owner_id):
        owner = await get_user_by_id(owner_id)
        current_count = (event.get("numResponses") or 0) + 1

        if owner and event.get("notificationsEnabled"):
            respondent_name = (
                payload.name if payload.guest else (requester or {}).get("name", "")
            )
            await email_service.send_someone_responded_email(
                owner, event, respondent_name or "익명"
            )

        threshold = event.get("sendEmailAfterXResponses")
        if owner and threshold and threshold > 0 and current_count == threshold:
            await events_col.update_one(
                {"_id": event["_id"]}, {"$set": {"sendEmailAfterXResponses": -1}}
            )
            await email_service.send_threshold_reached_email(
                owner, event, current_count
            )

    return {}


@router.delete("/{event_id}/response")
async def delete_event_response(
    event_id: str, payload: DeleteResponsePayload, request: Request
):
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    requester = await get_optional_user(request)
    try:
        await event_service.delete_response(event, payload, requester)
    except event_service.EventClosed as exc:
        raise HTTPException(
            status_code=409, detail="일정이 확정되어 더 이상 응답을 수정할 수 없습니다"
        ) from exc
    except event_service.NotSignedIn as exc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다") from exc
    except event_service.NotEventOwner as exc:
        raise HTTPException(status_code=403, detail="권한이 없습니다") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {}


@router.post("/{event_id}/rename-user")
async def rename_user(event_id: str, payload: RenameGuestPayload, request: Request):
    _limit_link_writes(request, "rename", limit=20)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    if payload.newName != payload.oldName and await event_service.guest_name_exists(
        event["_id"], payload.newName
    ):
        raise HTTPException(status_code=400, detail="이미 사용 중인 이름입니다")

    await event_service.rename_guest(event["_id"], payload.oldName, payload.newName)
    return {}


@router.delete("/{event_id}")
async def delete_event(event_id: str, request: Request, notify: bool = True):
    """`notify=false`면 취소 안내 메일을 보내지 않습니다 (시험용 일정 등)."""
    user = await require_user(request)
    if not ObjectId.is_valid(event_id):
        raise HTTPException(status_code=400, detail="잘못된 이벤트 ID입니다")

    event = await events_col.find_one(
        {"_id": ObjectId(event_id), "ownerId": user["_id"]}
    )
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    notified = await event_service.delete_event(event, user, notify=notify)
    return {"notifiedCount": notified}


@router.post("/{event_id}/invite")
async def send_invites(event_id: str, payload: SendInvitePayload, request: Request):
    """Emails the event link to people the host picks (contacts or typed in)."""
    user = await require_user(request)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    # Only the host may send mail on an event's behalf. Ownerless (guest-created)
    # events are editable by anyone with the link, but letting anyone send mail
    # from them would turn the app into an open relay.
    if event.get("ownerId") != user["_id"]:
        raise HTTPException(
            status_code=403, detail="일정을 만든 사람만 초대를 보낼 수 있습니다"
        )

    recipients = list(dict.fromkeys(str(e).strip().lower() for e in payload.emails))

    mails = [
        email_service.build_event_invite_mail(email, user, event, payload.message)
        for email in recipients
    ]

    # 초대한 사람을 적어 둡니다 - 나중에 "아직 응답 안 한 사람"에게 리마인더를
    # 보내려면 누구를 불렀는지 알아야 합니다 (mail_targets).
    await event_service.remember_invitees(event, recipients)

    # 발송을 기다리지 않습니다 - 최대 20명이면 메일 서버와의 왕복만 몇 초라,
    # 기다리면 다이얼로그가 그동안 멈춰 있는 것처럼 보입니다.
    queued = email_service.send_many_detached(mails)
    return {"sent": queued}


async def _require_event_host(event_id: str, request: Request) -> tuple[dict, dict]:
    """메일을 보내려는 사람이 이 일정의 주최자인지. 주인 없는(게스트가 만든)
    일정에서 아무나 메일을 보낼 수 있으면 이 앱이 발송 대행이 됩니다."""
    user = await require_user(request)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    if event.get("ownerId") != user["_id"]:
        raise HTTPException(
            status_code=403, detail="일정을 만든 사람만 메일을 보낼 수 있습니다"
        )
    return event, user


@router.get("/{event_id}/mail-targets")
async def mail_targets(event_id: str, request: Request):
    """메일 보내기 창이 채울 명단 - 응답한 사람 / 아직 안 한 사람."""
    event, user = await _require_event_host(event_id, request)
    return await event_service.mail_targets(event, user)


@router.post("/{event_id}/message")
async def send_message(event_id: str, payload: SendMessagePayload, request: Request):
    """주최자가 고른 사람들에게 짧은 안내를 보냅니다 (응답 재촉 등)."""
    event, user = await _require_event_host(event_id, request)
    recipients = list(
        dict.fromkeys(str(e).strip() for e in payload.emails if e.strip())
    )
    if not recipients:
        raise HTTPException(status_code=400, detail="받는 사람을 선택해 주세요")

    if payload.combined:
        # 전체 수신자를 To에 나란히 넣은 한 통 + 주최자 참조(Cc). 수신자끼리
        # 서로를 보고 전체 답장할 수 있고, 주최자에게도 사본이 남습니다.
        mails = [
            email_service.build_event_message_mail(
                recipients[0],
                user,
                event,
                payload.message,
                subject=payload.subject,
                extra_to=tuple(recipients[1:]),
                cc=(user["email"],),
            )
        ]
    else:
        mails = [
            email_service.build_event_message_mail(
                email, user, event, payload.message, subject=payload.subject
            )
            for email in recipients
        ]

    email_service.send_many_detached(mails)
    # 화면에는 메일 통수가 아니라 받는 사람 수를 알려 줍니다 - 한 통으로
    # 묶었어도 "N명에게 보냈다"가 사용자가 알고 싶은 사실입니다.
    return {"sent": len(recipients)}


@router.post("/{event_id}/duplicate")
async def duplicate_event(
    event_id: str, payload: DuplicateEventPayload, request: Request
):
    user = await require_user(request)
    # 복제도 새 일정을 만드는 것이므로 같은 제한을 받습니다.
    _require_member_to_create(request, user)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    # 참여만 하고 있는 남의 일정은 복제 대상이 아닙니다 (수정·보관·삭제와 동일).
    # 소유자 없는 게스트 생성 일정은 링크를 가진 누구나 다룰 수 있어 예외입니다.
    if event.get("ownerId") is not None and event.get("ownerId") != user["_id"]:
        raise HTTPException(
            status_code=403, detail="내가 만든 일정만 복제할 수 있습니다"
        )

    new_event = await event_service.duplicate_event(
        event, payload.eventName, payload.copyAvailability, user
    )
    return {"eventId": str(new_event["_id"]), "shortId": new_event.get("shortId")}


async def _deleted_owned_event(user: dict, event_id: str) -> dict:
    """휴지통 안의 내 일정을 가져옵니다.

    일반 조회 함수는 isDeleted를 걸러 내므로 여기서 직접 찾습니다.
    ownerId를 함께 걸어 남의 휴지통에는 손댈 수 없습니다.
    """
    oid = to_object_id(event_id)
    event = (
        await events_col.find_one(
            {"_id": oid, "ownerId": user["_id"], "isDeleted": True}
        )
        if oid
        else None
    )
    if event is None:
        raise HTTPException(status_code=404, detail="휴지통에서 찾을 수 없습니다")
    return event


@router.post("/{event_id}/restore")
async def restore_event(event_id: str, request: Request, notify: bool = False):
    """`notify=true`면 취소 안내를 받았던 사람들에게 정정 안내를 보냅니다."""
    user = await require_user(request)
    event = await _deleted_owned_event(user, event_id)
    notified = await event_service.restore_event(event, user, notify=notify)
    return {"notifiedCount": notified}


@router.delete("/{event_id}/purge")
async def purge_event(event_id: str, request: Request):
    """휴지통에서 완전히 지웁니다 - 응답·초대·폴더 연결·면담 기록까지."""
    user = await require_user(request)
    event = await _deleted_owned_event(user, event_id)
    return {"removed": await event_service.purge_event(event, user)}


@router.post("/{event_id}/guidance-records")
async def set_guidance_records(event_id: str, request: Request, enabled: bool = True):
    """지도 면담 기능을 켜고 끕니다 (주최자 전용).

    만들 때 체크하지 않았던 주최자가 일정 페이지에서 바로 켤 수 있게 한
    것입니다 - "일정 정보 수정"까지 가서 체크박스를 찾게 하면, 애초에
    그 옵션의 존재를 몰랐던 사람은 왜 기록 기능이 없는지 알 수 없습니다.
    """
    user = await require_user(request)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    if event.get("ownerId") != user["_id"]:
        raise HTTPException(
            status_code=403, detail="일정을 만든 사람만 바꿀 수 있습니다"
        )
    await events_col.update_one(
        {"_id": event["_id"]}, {"$set": {"guidanceRecordsEnabled": enabled}}
    )
    return {"guidanceRecordsEnabled": enabled}


@router.post("/{event_id}/archive")
async def archive_event(event_id: str, request: Request, archived: bool = True):
    user = await require_user(request)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    if event.get("ownerId") != user["_id"]:
        raise HTTPException(status_code=403, detail="권한이 없습니다")

    await event_service.archive_event(event, archived)
    return {}
