from fastapi import APIRouter, HTTPException, Request, status

from app.schemas.contact import AddContactRequest, UpdateContactRequest
from app.services import contact_service
from app.services.auth_service import require_user

router = APIRouter(prefix="/api/contacts", tags=["contacts"])


@router.get("")
async def list_contacts(request: Request):
    user = await require_user(request)
    return await contact_service.list_contacts(user)


@router.get("/search")
async def search_contacts(request: Request, q: str = ""):
    """Looks up registered users by name or email, to add as a contact."""
    user = await require_user(request)
    return await contact_service.search_users(
        q, exclude_user_id=user["_id"], owner_id=user["_id"]
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def add_contact(
    payload: AddContactRequest, request: Request, overwrite: bool = False
):
    """`overwrite=true` (used by the bulk paste) refreshes an existing
    contact with the same email instead of rejecting the duplicate."""
    user = await require_user(request)
    details = payload.model_dump(exclude={"email", "name"}, exclude_none=True)

    if overwrite:
        created = await contact_service.upsert_contact(
            user, payload.name, payload.email, details
        )
        return {"created": created}

    try:
        contact = await contact_service.add_contact(
            user, payload.name, payload.email, details
        )
    except contact_service.ContactAlreadyExists as exc:
        raise HTTPException(status_code=400, detail="이미 연락처에 있습니다.") from exc
    return {"id": str(contact["_id"]), "created": True}


@router.patch("/{contact_id}")
async def update_contact(
    contact_id: str, payload: UpdateContactRequest, request: Request
):
    user = await require_user(request)
    details = payload.model_dump(exclude={"email", "name"})
    try:
        updated = await contact_service.update_contact(
            user, contact_id, payload.name, payload.email, details
        )
    except contact_service.ContactAlreadyExists as exc:
        raise HTTPException(
            status_code=400, detail="이미 사용 중인 이메일입니다."
        ) from exc
    if not updated:
        raise HTTPException(status_code=404, detail="연락처를 찾을 수 없습니다")
    return {}


@router.delete("/{contact_id}")
async def delete_contact(contact_id: str, request: Request):
    user = await require_user(request)
    if not await contact_service.delete_contact(user, contact_id):
        raise HTTPException(status_code=404, detail="연락처를 찾을 수 없습니다")
    return {}
