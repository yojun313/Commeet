import json

from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse

from app.config import GOOGLE_CALENDAR_ENABLED
from app.core.templates import templates
from app.services import event_service
from app.services.auth_service import get_optional_user, public_profile

router = APIRouter(tags=["pages"])


def _event_config_json(event_id: str, is_group: bool, user: dict | None) -> str:
    return json.dumps(
        {
            "eventId": event_id,
            "isGroup": is_group,
            "currentUser": public_profile(user),
            "currentUserEmail": user["email"] if user else None,
            "googleCalendarEnabled": GOOGLE_CALENDAR_ENABLED,
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
        return RedirectResponse("/sign-in")
    return templates.TemplateResponse(
        request=request, name="settings.html", context={"user": user}
    )


@router.get("/contacts")
async def contacts(request: Request):
    user = await get_optional_user(request)
    if not user:
        return RedirectResponse("/sign-in")
    return templates.TemplateResponse(
        request=request, name="contacts.html", context={"user": user}
    )


@router.get("/sign-in")
async def sign_in(request: Request):
    user = await get_optional_user(request)
    if user:
        return RedirectResponse("/home")
    return templates.TemplateResponse(
        request=request,
        name="auth/sign_in.html",
        context={"user": None, "mode": "sign-in"},
    )


@router.get("/sign-up")
async def sign_up(request: Request):
    user = await get_optional_user(request)
    if user:
        return RedirectResponse("/home")
    return templates.TemplateResponse(
        request=request,
        name="auth/sign_in.html",
        context={"user": None, "mode": "sign-up"},
    )


@router.get("/privacy-policy")
async def privacy_policy(request: Request):
    user = await get_optional_user(request)
    return templates.TemplateResponse(
        request=request, name="privacy_policy.html", context={"user": user}
    )


@router.get("/e/{event_id}")
async def event_page(event_id: str, request: Request):
    user = await get_optional_user(request)
    event = await event_service.get_event_by_either_id(event_id)
    if event is None:
        return templates.TemplateResponse(
            request=request,
            name="errors/404.html",
            context={"user": user},
            status_code=404,
        )
    if event["type"] == "group":
        return RedirectResponse(f"/g/{event.get('shortId') or event['_id']}")

    event_id_str = event.get("shortId") or str(event["_id"])
    return templates.TemplateResponse(
        request=request,
        name="event/event.html",
        context={
            "user": user,
            "event_id": event_id_str,
            "event_name": event.get("name", ""),
            "is_group": False,
            "config_json": _event_config_json(event_id_str, False, user),
        },
    )


@router.get("/g/{group_id}")
async def group_page(group_id: str, request: Request):
    user = await get_optional_user(request)
    event = await event_service.get_event_by_either_id(group_id)
    if event is None or event["type"] != "group":
        return templates.TemplateResponse(
            request=request,
            name="errors/404.html",
            context={"user": user},
            status_code=404,
        )

    event_id_str = event.get("shortId") or str(event["_id"])
    return templates.TemplateResponse(
        request=request,
        name="event/group.html",
        context={
            "user": user,
            "event_id": event_id_str,
            "event_name": event.get("name", ""),
            "is_group": True,
            "config_json": _event_config_json(event_id_str, True, user),
        },
    )
