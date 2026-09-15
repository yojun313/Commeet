from fastapi import APIRouter, HTTPException, Request

from app.core.serialize import jsonable
from app.schemas.finalize import ConfirmRequest, ProposalRequest
from app.services import event_service, finalize_service
from app.services.auth_service import require_user

router = APIRouter(prefix="/api/events", tags=["finalize"])


async def _require_host(event_id: str, request: Request) -> tuple[dict, dict]:
    user = await require_user(request)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    if event.get("ownerId") != user["_id"]:
        raise HTTPException(
            status_code=403, detail="일정을 만든 사람만 확정할 수 있습니다"
        )
    return event, user


@router.post("/{event_id}/finalize/proposal")
async def propose(event_id: str, payload: ProposalRequest, request: Request):
    """Runs the optimizer and returns an editable draft schedule."""
    event, _host = await _require_host(event_id, request)
    try:
        proposal = await finalize_service.build_proposal(
            event, payload.capacity, payload.meetingMinutes, payload.allowIfNeeded
        )
    except finalize_service.InvalidMeetingLength as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return jsonable(proposal)


@router.post("/{event_id}/finalize/confirm")
async def confirm(event_id: str, payload: ConfirmRequest, request: Request):
    event, host = await _require_host(event_id, request)
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
        )
    except (
        finalize_service.InvalidMeetingLength,
        finalize_service.InvalidMeeting,
    ) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return jsonable(finalization)


@router.post("/{event_id}/finalize/cancel")
async def cancel(event_id: str, request: Request):
    event, host = await _require_host(event_id, request)
    try:
        await finalize_service.cancel(event, host)
    except finalize_service.EventNotClosable as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {}
