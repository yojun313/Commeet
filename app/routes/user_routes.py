from fastapi import APIRouter, HTTPException, Request, Response

from app.config import GOOGLE_CALENDAR_ENABLED
from app.core.ids import to_object_id
from app.core.serialize import jsonable
from app.schemas.folder import SetEventFolderRequest
from app.schemas.user import (
    CoHostPrefRequest,
    ChangePasswordRequest,
    DeleteAccountRequest,
    UpdateCalendarOptionsRequest,
    UpdateNameRequest,
)
from app.services import auth_service, event_service, folder_service, user_service
from app.services.auth_service import clear_session_cookie, require_user

router = APIRouter(prefix="/api/user", tags=["user"])
public_router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/profile")
async def get_profile(request: Request):
    user = await require_user(request)
    return jsonable(
        {
            "_id": str(user["_id"]),
            "email": user["email"],
            "name": user.get("name", ""),
            "picture": user.get("picture", ""),
            # 연동을 꺼 둔 서버에서는 화면에 쓸 곳이 없으므로 내보내지
            # 않습니다. 저장된 계정 정보 자체는 지우지 않아, 다시 켜면
            # 그대로 돌아옵니다.
            "calendarAccounts": {}
            if not GOOGLE_CALENDAR_ENABLED
            else {
                key: {
                    **{k: v for k, v in account.items() if k != "oauth"},
                    # Confirmed Commeet meetings only get mirrored onto accounts
                    # whose granted OAuth scope includes calendar.events -
                    # accounts connected before that scope was added only
                    # have read-only access until the user reconnects (a
                    # token refresh never grants scopes beyond what was
                    # originally consented to).
                    "hasWriteScope": "calendar.events"
                    in ((account.get("oauth") or {}).get("scope") or ""),
                }
                for key, account in (user.get("calendarAccounts") or {}).items()
            },
            "calendarOptions": user.get("calendarOptions"),
            "numEventsCreated": user.get("numEventsCreated", 0),
        }
    )


@router.get("/co-host-prefs")
async def get_co_host_prefs(request: Request):
    """일정 창이 공동주최자 권한 체크를 채울 때 씁니다 - 사람별로 기억한
    권한과, 처음 넣는 사람에게 쓸 가장 최근 권한."""
    user = await require_user(request)
    return user_service.get_co_host_prefs(user)


@router.put("/co-host-prefs")
async def save_co_host_pref(payload: CoHostPrefRequest, request: Request):
    user = await require_user(request)
    await user_service.save_co_host_prefs(user, [(payload.email, payload.perms)])
    return {}


@router.patch("/name")
async def update_name(payload: UpdateNameRequest, request: Request):
    user = await require_user(request)
    await user_service.update_name(user, payload.name)
    return {}


@router.patch("/password")
async def change_password(payload: ChangePasswordRequest, request: Request):
    user = await require_user(request)
    try:
        await auth_service.change_password(
            user, payload.currentPassword, payload.newPassword
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {}


@router.patch("/calendar-options")
async def update_calendar_options(
    payload: UpdateCalendarOptionsRequest, request: Request
):
    user = await require_user(request)
    buffer_time = payload.bufferTime.model_dump() if payload.bufferTime else None
    working_hours = payload.workingHours.model_dump() if payload.workingHours else None
    options = await user_service.update_calendar_options(
        user, buffer_time, working_hours
    )
    return jsonable(options)


@router.get("/events/version")
async def get_my_events_version(request: Request):
    """대시보드·캘린더가 자동 갱신 여부를 판단할 때 두드리는 엔드포인트.
    본문은 지문 하나뿐이라, 실제로 바뀌었을 때만 무거운 조회를 합니다."""
    user = await require_user(request)
    return {"v": await user_service.get_dashboard_version(user)}


@router.get("/events")
async def get_my_events(request: Request):
    user = await require_user(request)
    return jsonable(await user_service.get_dashboard_events(user))


@router.get("/deleted-events")
async def get_deleted_events(request: Request):
    """휴지통 페이지용. 남이 응답한 일정을 지우면 숨김 처리되는데,
    그렇게 숨겨진 내 일정 목록입니다."""
    user = await require_user(request)
    return jsonable(await event_service.list_deleted_events(user))


@router.post("/events/{event_id}/set-folder")
async def set_event_folder(
    event_id: str, payload: SetEventFolderRequest, request: Request
):
    user = await require_user(request)
    event_oid = to_object_id(event_id)
    if event_oid is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")
    folder_oid = to_object_id(payload.folderId) if payload.folderId else None
    await folder_service.set_event_folder(event_oid, user["_id"], folder_oid)
    return {}


@router.delete("")
async def delete_account(
    payload: DeleteAccountRequest, request: Request, response: Response
):
    user = await require_user(request)
    if payload.email.strip().lower() != user["email"]:
        raise HTTPException(status_code=400, detail="이메일이 일치하지 않습니다")
    await user_service.delete_account(user)
    clear_session_cookie(response)
    return {}


@public_router.get("/{user_id}")
async def get_public_profile(user_id: str):
    profile = await user_service.get_public_profile(user_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    return profile
