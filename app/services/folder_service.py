from bson import ObjectId

from app.core.ids import to_object_id
from app.db import events_col, folder_events_col, folders_col


async def get_event_ids_in_folder(
    folder_id: ObjectId, user_id: ObjectId
) -> list[ObjectId]:
    docs = await folder_events_col.find(
        {"folderId": folder_id, "userId": user_id}
    ).to_list(length=None)
    return [d["eventId"] for d in docs]


async def get_all_folders(user_id: ObjectId) -> list[dict]:
    folders = (
        await folders_col.find({"userId": user_id, "isDeleted": {"$ne": True}})
        .sort("_id", 1)
        .to_list(length=None)
    )
    for folder in folders:
        folder["eventIds"] = await get_event_ids_in_folder(folder["_id"], user_id)
    return folders


async def get_folder(folder_id: str, user_id: ObjectId) -> dict | None:
    oid = to_object_id(folder_id)
    if oid is None:
        return None
    folder = await folders_col.find_one(
        {"_id": oid, "userId": user_id, "isDeleted": {"$ne": True}}
    )
    if folder:
        folder["eventIds"] = await get_event_ids_in_folder(folder["_id"], user_id)
    return folder


async def create_folder(user_id: ObjectId, name: str, color: str | None) -> dict:
    doc = {"userId": user_id, "name": name, "color": color, "isDeleted": False}
    result = await folders_col.insert_one(doc)
    doc["_id"] = result.inserted_id
    doc["eventIds"] = []
    return doc


async def update_folder(
    folder_id: ObjectId, user_id: ObjectId, name: str | None, color: str | None
) -> None:
    updates = {}
    if name is not None:
        updates["name"] = name
    if color is not None:
        updates["color"] = color
    if updates:
        await folders_col.update_one(
            {"_id": folder_id, "userId": user_id}, {"$set": updates}
        )


async def delete_folder(folder_id: ObjectId, user_id: ObjectId) -> None:
    event_ids = await get_event_ids_in_folder(folder_id, user_id)
    await folders_col.update_one(
        {"_id": folder_id, "userId": user_id}, {"$set": {"isDeleted": True}}
    )
    if event_ids:
        await events_col.update_many(
            {"_id": {"$in": event_ids}, "ownerId": user_id},
            {"$set": {"isDeleted": True}},
        )
    await folder_events_col.delete_many({"folderId": folder_id, "userId": user_id})


async def set_event_folder(
    event_id: ObjectId, user_id: ObjectId, folder_id: ObjectId | None
) -> None:
    await folder_events_col.delete_many({"eventId": event_id, "userId": user_id})
    if folder_id is not None:
        await folder_events_col.insert_one(
            {"userId": user_id, "folderId": folder_id, "eventId": event_id}
        )
