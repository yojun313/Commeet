from fastapi import APIRouter, HTTPException, Request, status

from app.core.ids import to_object_id
from app.core.serialize import jsonable
from app.schemas.folder import CreateFolderRequest, UpdateFolderRequest
from app.services import folder_service
from app.services.auth_service import require_user

router = APIRouter(prefix="/api/folders", tags=["folders"])


@router.get("")
async def list_folders(request: Request):
    user = await require_user(request)
    return jsonable(await folder_service.get_all_folders(user["_id"]))


@router.get("/{folder_id}")
async def get_folder(folder_id: str, request: Request):
    user = await require_user(request)
    folder = await folder_service.get_folder(folder_id, user["_id"])
    if folder is None:
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다")
    return jsonable(folder)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_folder(payload: CreateFolderRequest, request: Request):
    user = await require_user(request)
    folder = await folder_service.create_folder(
        user["_id"], payload.name, payload.color
    )
    return {"id": str(folder["_id"])}


@router.patch("/{folder_id}")
async def update_folder(folder_id: str, payload: UpdateFolderRequest, request: Request):
    user = await require_user(request)
    oid = to_object_id(folder_id)
    if oid is None:
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다")
    await folder_service.update_folder(oid, user["_id"], payload.name, payload.color)
    return {}


@router.delete("/{folder_id}")
async def delete_folder(folder_id: str, request: Request):
    user = await require_user(request)
    oid = to_object_id(folder_id)
    if oid is None:
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다")
    await folder_service.delete_folder(oid, user["_id"])
    return {}
