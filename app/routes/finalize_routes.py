from fastapi import APIRouter, HTTPException, Request

from app.core.serialize import jsonable
from app.schemas.finalize import ConfirmRequest, ProposalRequest
from app.services import event_service, finalize_service
from app.services.auth_service import get_user_by_id, require_user

router = APIRouter(prefix="/api/events", tags=["finalize"])


async def _require_host(event_id: str, request: Request) -> tuple[dict, dict, dict]:
    """(일정, 주최자, 요청한 사람). "배정·확정" 권한의 공동주최자도 확정할
    수 있지만, 약속은 주최자의 것입니다 - 주최자가 모든 약속에 들어가고
    주최자 캘린더에 등록됩니다. 넘기는 주최자 문서는 이름만 "주최자 모두"
    (주최자 + 이름 표시 권한의 공동주최자)로 바꾼 사본이라, 안내 메일과
    캘린더 초대에 그 이름들이 함께 나갑니다."""
    user = await require_user(request)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    if not event_service.has_perm(event, user, "finalize"):
        raise HTTPException(status_code=403, detail="확정할 권한이 없습니다")
    owner = (
        user
        if event["ownerId"] == user["_id"]
        else await get_user_by_id(str(event["ownerId"])) or user
    )
    return event, await event_service.as_hosts(event, owner), user


@router.post("/{event_id}/finalize/proposal")
async def propose(event_id: str, payload: ProposalRequest, request: Request):
    """Runs the optimizer and returns an editable draft schedule."""
    event, _host, _user = await _require_host(event_id, request)
    try:
        proposal = await finalize_service.build_proposal(
            event, payload.capacity, payload.meetingMinutes, payload.allowIfNeeded
        )
    except finalize_service.InvalidMeetingLength as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return jsonable(proposal)


@router.post("/{event_id}/finalize/confirm")
async def confirm(event_id: str, payload: ConfirmRequest, request: Request):
    event, host, user = await _require_host(event_id, request)
    try:
        finalization = await finalize_service.confirm(
            event,
            host,
            payload.capacity,
            payload.meetingMinutes,
            [
                {"start": m.start, "participants": m.participants}
                for m in payload.meetings
            ],
            calendar_invite=payload.calendarInvite,
            confirmed_by=user["_id"],
        )
    except (
        finalize_service.InvalidMeetingLength,
        finalize_service.InvalidMeeting,
    ) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return jsonable(finalization)


@router.post("/{event_id}/finalize/cancel")
async def cancel(event_id: str, request: Request):
    event, host, _user = await _require_host(event_id, request)
    try:
        await finalize_service.cancel(event, host)
    except finalize_service.EventNotClosable as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {}
