from fastapi import APIRouter, HTTPException, Request, Response

from app.core.ids import to_object_id
from app.core.serialize import jsonable
from app.schemas.folder import SetEventFolderRequest
from app.schemas.user import (
    ChangePasswordRequest,
    DeleteAccountRequest,
    UpdateCalendarOptionsRequest,
    UpdateNameRequest,
)
from app.services import auth_service, folder_service, user_service
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
            "calendarAccounts": {
                key: {k: v for k, v in account.items() if k != "oauth"}
                for key, account in (user.get("calendarAccounts") or {}).items()
            },
            "calendarOptions": user.get("calendarOptions"),
            "numEventsCreated": user.get("numEventsCreated", 0),
        }
    )


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


@router.get("/events")
async def get_my_events(request: Request):
    user = await require_user(request)
    return jsonable(await user_service.get_dashboard_events(user))


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
