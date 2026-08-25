from datetime import datetime

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request, status

from app.core.serialize import jsonable
from app.db import events_col
from app.schemas.event import (
    DeleteResponsePayload,
    DuplicateEventPayload,
    EventPayload,
    EventResponsePayload,
    RenameGuestPayload,
    SendInvitePayload,
)
from app.services import email_service, event_service
from app.services.auth_service import get_optional_user, get_user_by_id, require_user

router = APIRouter(prefix="/api/events", tags=["events"])


async def _check_group_access(event: dict, viewer: dict | None) -> None:
    """Groups are permissioned: only the owner and invited attendees may view
    them (unlike regular events, which are open to anyone with the link)."""
    if event["type"] != "group":
        return
    if not viewer:
        raise HTTPException(status_code=401, detail="그룹을 보려면 로그인이 필요합니다")
    if event.get("ownerId") == viewer["_id"]:
        return
    attendees = await event_service.get_attendees(event["_id"])
    if any(a["email"] == viewer["email"] for a in attendees):
        return
    raise HTTPException(status_code=403, detail="이 그룹에 접근할 권한이 없습니다")


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_event(payload: EventPayload, request: Request):
    owner = await get_optional_user(request)
    event = await event_service.create_event(payload, owner)
    return {"eventId": str(event["_id"]), "shortId": event.get("shortId")}


@router.put("/{event_id}")
async def edit_event(event_id: str, payload: EventPayload, request: Request):
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    requester = await get_optional_user(request)
    try:
        await event_service.update_event(event, payload, requester)
    except event_service.NotEventOwner as exc:
        raise HTTPException(
            status_code=403, detail="이 이벤트를 수정할 권한이 없습니다"
        ) from exc

    return {}


@router.get("/{event_id}/ids")
async def get_event_ids(event_id: str):
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    return {"shortId": event.get("shortId") or "", "longId": str(event["_id"])}


@router.get("/{event_id}")
async def get_event(event_id: str, request: Request, guestName: str | None = None):
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    viewer = await get_optional_user(request)
    await _check_group_access(event, viewer)
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

    if event["type"] == "group":
        result["attendees"] = await event_service.get_attendees(event["_id"])
        if viewer:
            result["hasResponded"] = str(viewer["_id"]) in responses_map

    if event.get("blindAvailabilityEnabled") and not is_owner:
        result["numResponses"] = None
        result["remindees"] = None

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
    await _check_group_access(event, viewer)
    is_owner = bool(viewer) and event.get("ownerId") == viewer["_id"]

    responses_map = await event_service.get_filtered_responses_map(
        event, timeMin, timeMax, is_owner=is_owner
    )
    responses_map = event_service.apply_blind_filter(
        event, responses_map, viewer=viewer, is_owner=is_owner, guest_name=guestName
    )
    return jsonable(responses_map)


@router.post("/{event_id}/response")
async def update_event_response(
    event_id: str, payload: EventResponsePayload, request: Request
):
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    requester = await get_optional_user(request)
    await _check_group_access(event, requester)

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

        if owner and (event.get("notificationsEnabled") or event["type"] == "group"):
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
async def rename_user(event_id: str, payload: RenameGuestPayload):
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    if payload.newName != payload.oldName and await event_service.guest_name_exists(
        event["_id"], payload.newName
    ):
        raise HTTPException(status_code=400, detail="이미 사용 중인 이름입니다")

    await event_service.rename_guest(event["_id"], payload.oldName, payload.newName)
    return {}


@router.post("/{event_id}/decline")
async def decline_invite(event_id: str, request: Request):
    user = await require_user(request)
    event = await event_service.get_event_by_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    if event["type"] != "group":
        raise HTTPException(status_code=400, detail="그룹 이벤트가 아닙니다")

    if not await event_service.decline_invite(event, user):
        raise HTTPException(status_code=404, detail="초대 목록에서 찾을 수 없습니다")
    return {}


@router.get("/{event_id}/calendar-availabilities")
async def calendar_availabilities(
    event_id: str, request: Request, timeMin: datetime, timeMax: datetime
):
    user = await require_user(request)
    event = await event_service.get_event_by_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    if event["type"] != "group":
        raise HTTPException(status_code=400, detail="그룹 이벤트가 아닙니다")
    await _check_group_access(event, user)

    result = await event_service.get_calendar_availabilities(
        event, timeMin, timeMax, user
    )
    return jsonable(result)


@router.delete("/{event_id}")
async def delete_event(event_id: str, request: Request):
    user = await require_user(request)
    if not ObjectId.is_valid(event_id):
        raise HTTPException(status_code=400, detail="잘못된 이벤트 ID입니다")

    event = await events_col.find_one(
        {"_id": ObjectId(event_id), "ownerId": user["_id"]}
    )
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    await event_service.delete_event(event, user)
    return {}


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

    is_group = event["type"] == "group"
    recipients = list(dict.fromkeys(str(e).strip().lower() for e in payload.emails))

    for email in recipients:
        if is_group:
            # Group access is invite-only, so sending the link must also grant entry.
            await event_service.add_attendee(event, email)
            await email_service.send_group_invite_email(
                email, user, event, payload.message
            )
        else:
            await email_service.send_event_invite_email(
                email, user, event, payload.message
            )

    return {"sent": len(recipients)}


@router.post("/{event_id}/duplicate")
async def duplicate_event(
    event_id: str, payload: DuplicateEventPayload, request: Request
):
    user = await require_user(request)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    new_event = await event_service.duplicate_event(
        event, payload.eventName, payload.copyAvailability, user
    )
    return {"eventId": str(new_event["_id"]), "shortId": new_event.get("shortId")}


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
