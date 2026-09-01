import json

from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse

from app.config import GOOGLE_CALENDAR_ENABLED, GUIDANCE_FEE_RATES
from app.core.redirects import redirect_to_sign_in, safe_next
from app.core.serialize import jsonable
from app.core.templates import templates
from app.db import users_col
from app.services import crypto_service, event_service, record_service
from app.services.auth_service import get_optional_user, public_profile

router = APIRouter(tags=["pages"])


def _event_config_json(event_id: str, user: dict | None) -> str:
    return json.dumps(
        {
            "eventId": event_id,
            "currentUser": public_profile(user),
            "currentUserEmail": user["email"] if user else None,
            "googleCalendarEnabled": GOOGLE_CALENDAR_ENABLED,
        }
    )


def _records_config_json(user: dict | None) -> str:
    """확정된 일정에서는 이벤트 페이지 안에서도 면담 기록 폼을 띄우므로
    (record-form.js), /records 페이지와 같은 설정을 함께 내려줍니다."""
    return json.dumps(
        {
            "feeRates": GUIDANCE_FEE_RATES,
            "professorName": (user or {}).get("name", ""),
        }
    )


@router.get("/")
async def landing(request: Request):
    user = await get_optional_user(request)
    return templates.TemplateResponse(
        request=request, name="landing.html", context={"user": user}
    )


@router.get("/home")
async def home(request: Request):
    user = await get_optional_user(request)
    if not user:
        return RedirectResponse("/")
    return templates.TemplateResponse(
        request=request, name="home.html", context={"user": user}
    )


@router.get("/settings")
async def settings(request: Request):
    user = await get_optional_user(request)
    if not user:
        return redirect_to_sign_in(request)
    return templates.TemplateResponse(
        request=request, name="settings.html", context={"user": user}
    )


@router.get("/contacts")
async def contacts(request: Request):
    user = await get_optional_user(request)
    if not user:
        return redirect_to_sign_in(request)
    return templates.TemplateResponse(
        request=request, name="contacts.html", context={"user": user}
    )


@router.get("/records/{record_id}/print")
async def record_print_page(record_id: str, request: Request):
    """Print-ready 학생지도비 신청서. Rendered server-side so Ctrl+P works on
    a fully laid-out page with no fetch flash - one form per settlement,
    since 컴공/무은재 amounts are filed separately."""
    user = await get_optional_user(request)
    if not user:
        return redirect_to_sign_in(request)
    try:
        record = await record_service.get_record(user, record_id)
    except (record_service.RecordNotFound, crypto_service.RecordDecryptionError):
        return templates.TemplateResponse(
            request=request,
            name="errors/404.html",
            context={"user": user},
            status_code=404,
        )

    present = [a for a in record["attendees"] if a.get("present")]
    forms = []
    for index, settlement in enumerate(record["settlements"]):
        forms.append(
            {
                "index": index,
                "settlement": settlement,
                "affiliationLabel": record_service.AFFILIATION_LABELS.get(
                    settlement.get("affiliation"), ""
                ),
                "attendees": [
                    a
                    for a in present
                    if a.get("affiliation") == settlement.get("affiliation")
                ],
            }
        )

    return templates.TemplateResponse(
        request=request,
        name="record_print.html",
        context={
            "user": user,
            "record": record,
            "forms": forms,
            "present": present,
            "note_categories": record_service.NOTE_CATEGORIES,
        },
    )


@router.get("/trash")
async def trash_page(request: Request):
    user = await get_optional_user(request)
    if not user:
        return redirect_to_sign_in(request)
    return templates.TemplateResponse(
        request=request, name="trash.html", context={"user": user}
    )


@router.get("/admin")
async def admin_page(request: Request):
    user = await get_optional_user(request)
    if not user:
        return redirect_to_sign_in(request)
    if not user.get("isAdmin"):
        return templates.TemplateResponse(
            request=request,
            name="errors/404.html",
            context={"user": user},
            status_code=404,
        )
    return templates.TemplateResponse(
        request=request, name="admin.html", context={"user": user}
    )


@router.get("/calendar")
async def calendar_page(request: Request):
    user = await get_optional_user(request)
    if not user:
        return redirect_to_sign_in(request)
    return templates.TemplateResponse(
        request=request,
        name="calendar.html",
        context={
            "user": user,
            "config_json": json.dumps({"userId": str(user["_id"])}),
        },
    )


@router.get("/sign-in")
async def sign_in(request: Request):
    """`?next=`가 붙어 있으면 로그인 후 그 경로로 돌아갑니다 (auth.js).
    이미 로그인한 상태로 들어왔다면 기다릴 것 없이 바로 보내 줍니다."""
    next_url = safe_next(request.query_params.get("next"))
    user = await get_optional_user(request)
    if user:
        return RedirectResponse(next_url)
    return templates.TemplateResponse(
        request=request,
        name="auth/sign_in.html",
        context={"user": None, "mode": "sign-in", "next_url": next_url},
    )


@router.get("/sign-up")
async def sign_up(request: Request):
    next_url = safe_next(request.query_params.get("next"))
    user = await get_optional_user(request)
    if user:
        return RedirectResponse(next_url)
    return templates.TemplateResponse(
        request=request,
        name="auth/sign_in.html",
        context={"user": None, "mode": "sign-up", "next_url": next_url},
    )


@router.get("/privacy-policy")
async def privacy_policy(request: Request):
    user = await get_optional_user(request)
    return templates.TemplateResponse(
        request=request, name="privacy_policy.html", context={"user": user}
    )


def _event_not_found_response(request: Request, user: dict | None):
    """초대 링크를 눌렀는데 일정이 없을 때.

    휴지통에 남아 있는 동안에는 _removed_event_response()가 "취소/삭제
    되었습니다"라고 정확히 알려 주지만, 완전히 지워진 뒤에는 문서 자체가
    없어 그것조차 알 수 없습니다. 그때 맨 404만 보여 주면 받는 쪽에서는
    자기 링크가 잘못된 줄 알고 계속 다시 눌러 보게 됩니다 - 취소되었을
    수도 있다는 가능성을 같이 적어 둡니다.
    """
    return templates.TemplateResponse(
        request=request,
        name="errors/404.html",
        context={
            "user": user,
            "message": "이 링크의 일정을 찾을 수 없습니다.",
            "hint": (
                "주소가 잘못되었거나, 주최자가 일정을 취소하거나 삭제했을 수 "
                "있습니다. 링크를 보내 준 분에게 확인해 주세요."
            ),
        },
        status_code=404,
    )


async def _removed_event_response(request: Request, user: dict | None, event_id: str):
    """지워진 일정 링크를 눌렀을 때 "취소/삭제되었습니다"를 보여 줍니다.
    해당하지 않으면 None."""
    removed = await event_service.get_removed_event(event_id)
    if removed is None:
        return None
    host = None
    if removed.get("ownerId"):
        host = await users_col.find_one({"_id": removed["ownerId"]}, {"name": 1})
    return templates.TemplateResponse(
        request=request,
        name="errors/removed_event.html",
        context={
            "user": user,
            "word": event_service.removal_word(removed),
            "event_name": removed.get("name", ""),
            "host_name": (host or {}).get("name") or "",
        },
        status_code=410,  # Gone - 있었지만 이제 없음
    )


@router.get("/e/{event_id}")
async def event_page(event_id: str, request: Request):
    user = await get_optional_user(request)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        removed = await _removed_event_response(request, user, event_id)
        if removed is not None:
            return removed
        return _event_not_found_response(request, user)
    event_id_str = event.get("shortId") or str(event["_id"])
    return templates.TemplateResponse(
        request=request,
        name="event/event.html",
        context={
            "user": user,
            "event_id": event_id_str,
            "event_name": event.get("name", ""),
            "config_json": _event_config_json(event_id_str, user),
            "records_config_json": _records_config_json(user),
        },
    )


@router.get("/e/{event_id}/finalize")
async def finalize_page(event_id: str, request: Request):
    user = await get_optional_user(request)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        removed = await _removed_event_response(request, user, event_id)
        if removed is not None:
            return removed
        return _event_not_found_response(request, user)
    if not user:
        return redirect_to_sign_in(request)
    if event.get("ownerId") != user["_id"]:
        return RedirectResponse(f"/e/{event.get('shortId') or event['_id']}")

    event_id_str = event.get("shortId") or str(event["_id"])
    return templates.TemplateResponse(
        request=request,
        name="event/finalize.html",
        context={
            "user": user,
            "event_id": event_id_str,
            "event_name": event.get("name", ""),
            "time_increment": int(event.get("timeIncrement") or 15),
            "duration_hours": float(event.get("duration") or 0),
            "config_json": json.dumps(
                {
                    "eventId": event_id_str,
                    "eventName": event.get("name", ""),
                    "timeIncrement": int(event.get("timeIncrement") or 15),
                    "durationHours": float(event.get("duration") or 0),
                    "finalization": jsonable(event.get("finalization")),
                }
            ),
        },
    )
