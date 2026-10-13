from fastapi import APIRouter, HTTPException, Request

from app.config import MAIL_BACKEND, MAIL_ENABLED, MAIL_SENDER
from app.core.serialize import jsonable
from app.schemas.admin import SetAdminRequest, TestMailRequest
from app.services import access_log_service, admin_service, email_service
from app.services.auth_service import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/users")
async def list_users(request: Request):
    await require_admin(request)
    return jsonable(await admin_service.list_users())


@router.get("/users/{user_id}")
async def get_user_detail(user_id: str, request: Request):
    await require_admin(request)
    try:
        return jsonable(await admin_service.get_user_detail(user_id))
    except admin_service.UserNotFound as exc:
        raise HTTPException(
            status_code=404, detail="사용자를 찾을 수 없습니다"
        ) from exc


@router.patch("/users/{user_id}/role")
async def set_user_role(user_id: str, payload: SetAdminRequest, request: Request):
    await require_admin(request)
    try:
        await admin_service.set_admin(user_id, payload.isAdmin)
    except admin_service.UserNotFound as exc:
        raise HTTPException(
            status_code=404, detail="사용자를 찾을 수 없습니다"
        ) from exc
    except admin_service.LastAdminError as exc:
        raise HTTPException(
            status_code=400, detail="마지막 관리자는 권한을 해제할 수 없습니다"
        ) from exc
    return {}


@router.get("/people")
async def list_people(request: Request):
    """누적 이용자 (가입자 + 같은 이름을 한 사람으로 묶은 게스트 응답자)."""
    await require_admin(request)
    return jsonable(await admin_service.list_people())


@router.get("/events")
async def list_events(request: Request):
    """모든 방 (휴지통 포함) - 대시보드의 방 목록 / 크게 보기."""
    await require_admin(request)
    return jsonable(await admin_service.list_events())


@router.get("/stats")
async def get_stats(request: Request, days: int = 30):
    await require_admin(request)
    return jsonable(await access_log_service.get_stats(days=min(max(days, 1), 90)))


@router.get("/logs")
async def get_logs(
    request: Request, page: int = 1, pageSize: int = 50, userId: str | None = None
):
    await require_admin(request)
    return jsonable(
        await access_log_service.list_logs(
            page=max(page, 1), page_size=min(max(pageSize, 1), 200), user_id=userId
        )
    )


@router.get("/mail-config")
async def get_mail_config(request: Request):
    await require_admin(request)
    return {"backend": MAIL_BACKEND, "sender": MAIL_SENDER, "enabled": MAIL_ENABLED}


@router.post("/test-mail")
async def send_test_mail(payload: TestMailRequest, request: Request):
    await require_admin(request)
    try:
        return await email_service.send_test_email(payload.to)
    except email_service.MailNotConfigured as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # Deliberately broad: whatever smtplib/DNS/TLS threw is the useful
    # answer here, so it goes straight back to the admin.
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"발송 실패: {type(exc).__name__}: {exc}"
        ) from exc
