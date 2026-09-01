import base64
import binascii
from datetime import datetime

from fastapi import APIRouter, File, HTTPException, Request, UploadFile, status
from fastapi.responses import Response

from app.core.serialize import jsonable
from app.schemas.record import SaveRecordRequest, SignatureRequest
from app.services import crypto_service, event_service, record_service
from app.services.auth_service import require_user

router = APIRouter(prefix="/api/records", tags=["records"])

# Receipts are phone photos or PDF scans; anything larger is a mistake.
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
ALLOWED_TYPES = {"image/png", "image/jpeg", "image/webp", "application/pdf"}
_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "application/pdf": "pdf",
}


async def _owned_event(user: dict, event_id: str) -> dict:
    event = await event_service.get_event_by_either_id(event_id)
    if not event or event.get("ownerId") != user["_id"]:
        raise HTTPException(status_code=404, detail="일정을 찾을 수 없습니다.")
    return event


@router.get("")
async def list_records(request: Request, eventId: str | None = None):
    """`eventId`를 주면 그 일정의 기록만 돌려줍니다 - 확정 화면은 자기
    일정의 기록만 필요하므로, 다른 일정 기록까지 내려보내지 않습니다.

    이벤트 링크는 짧은 공유 id로도 열리므로(/e/aB3f9), 어느 쪽이 와도 받아
    실제 ObjectId로 바꿔서 넘깁니다.
    """
    user = await require_user(request)
    owned_id = str((await _owned_event(user, eventId))["_id"]) if eventId else None
    return jsonable(
        {"records": await record_service.list_records(user, event_id=owned_id)}
    )


@router.get("/draft")
async def get_draft(request: Request, eventId: str, meetingStart: datetime):
    """The form's data for one meeting: the saved record if there is one,
    otherwise a draft prefilled from the confirmed schedule."""
    user = await require_user(request)
    event = await _owned_event(user, eventId)

    # 짧은 공유 id로 들어올 수 있으므로 반드시 실제 ObjectId로 조회합니다 -
    # 짧은 id를 그대로 넘기면 저장된 기록을 못 찾고 빈 초안이 나옵니다.
    existing = await record_service.get_by_meeting(
        user, str(event["_id"]), meetingStart
    )
    if existing:
        return jsonable(existing)

    try:
        return jsonable(await record_service.build_draft(event, user, meetingStart))
    except record_service.MeetingNotFound as exc:
        raise HTTPException(
            status_code=404, detail="확정된 약속을 찾을 수 없습니다."
        ) from exc


@router.get("/{record_id}")
async def get_record(record_id: str, request: Request):
    user = await require_user(request)
    try:
        return jsonable(await record_service.get_record(user, record_id))
    except record_service.RecordNotFound as exc:
        raise HTTPException(status_code=404, detail="기록을 찾을 수 없습니다.") from exc
    except crypto_service.RecordDecryptionError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("", status_code=status.HTTP_201_CREATED)
async def save_record(payload: SaveRecordRequest, request: Request):
    user = await require_user(request)
    try:
        record_id = await record_service.save_record(user, payload.model_dump())
    except record_service.RecordNotFound as exc:
        raise HTTPException(status_code=404, detail="일정을 찾을 수 없습니다.") from exc
    return {"id": record_id}


@router.put("/{record_id}/signature")
async def save_signature(record_id: str, payload: SignatureRequest, request: Request):
    """Stores the signature drawn on the canvas, sent as a data URL.

    An empty dataUrl means the host cleared the pad, so the stored signature
    is removed rather than replaced with a blank image.
    """
    user = await require_user(request)
    if not payload.dataUrl:
        try:
            await record_service.clear_signature(user, record_id)
        except record_service.RecordNotFound as exc:
            raise HTTPException(
                status_code=404, detail="기록을 찾을 수 없습니다."
            ) from exc
        return {"ok": True}

    prefix = "data:image/png;base64,"
    if not payload.dataUrl.startswith(prefix):
        raise HTTPException(
            status_code=400, detail="서명 이미지 형식이 올바르지 않습니다."
        )
    try:
        raw = base64.b64decode(payload.dataUrl[len(prefix) :], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=400, detail="서명 이미지를 읽지 못했습니다."
        ) from exc
    if len(raw) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=400, detail="서명 이미지가 너무 큽니다.")

    try:
        await record_service.attach_file(
            user, record_id, "signature.png", raw, "signature.png"
        )
    except record_service.RecordNotFound as exc:
        raise HTTPException(status_code=404, detail="기록을 찾을 수 없습니다.") from exc
    return {"ok": True}


@router.put("/{record_id}/receipt/{index}")
async def upload_receipt(
    record_id: str, index: int, request: Request, file: UploadFile = File(...)
):
    """One receipt per settlement - 컴공/무은재 amounts are paid separately."""
    user = await require_user(request)
    if index < 0 or index > 5:
        raise HTTPException(status_code=400, detail="잘못된 요청입니다.")
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail="이미지(PNG/JPG/WEBP) 또는 PDF만 첨부할 수 있습니다.",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="빈 파일입니다.")
    if len(raw) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=400, detail="파일은 8MB 이하만 첨부할 수 있습니다."
        )

    kind = f"receipt-{index}.{_EXTENSIONS[file.content_type]}"
    try:
        await record_service.attach_file(
            user, record_id, kind, raw, file.filename or "receipt"
        )
    except record_service.RecordNotFound as exc:
        raise HTTPException(status_code=404, detail="기록을 찾을 수 없습니다.") from exc
    return {"ok": True, "kind": kind}


@router.get("/{record_id}/file/{kind}")
async def download_file(record_id: str, kind: str, request: Request):
    """Serves an attachment, decrypted in memory - the file on disk stays
    encrypted and is never exposed through /static."""
    user = await require_user(request)
    if "/" in kind or "\\" in kind or ".." in kind:
        raise HTTPException(status_code=400, detail="잘못된 요청입니다.")
    try:
        raw = await record_service.read_file(user, record_id, kind)
    except record_service.RecordNotFound as exc:
        raise HTTPException(status_code=404, detail="기록을 찾을 수 없습니다.") from exc
    except crypto_service.RecordDecryptionError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if raw is None:
        raise HTTPException(status_code=404, detail="첨부파일이 없습니다.")

    ext = kind.rsplit(".", 1)[-1].lower()
    media = (
        "application/pdf"
        if ext == "pdf"
        else f"image/{'jpeg' if ext == 'jpg' else ext}"
    )
    return Response(
        content=raw, media_type=media, headers={"Cache-Control": "no-store"}
    )


@router.delete("/{record_id}")
async def delete_record(record_id: str, request: Request):
    user = await require_user(request)
    if not await record_service.delete_record(user, record_id):
        raise HTTPException(status_code=404, detail="기록을 찾을 수 없습니다.")
    return {"ok": True}
