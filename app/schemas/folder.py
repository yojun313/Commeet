from pydantic import BaseModel, Field


class CreateFolderRequest(BaseModel):
    name: str = Field(min_length=1)
    color: str | None = None


class UpdateFolderRequest(BaseModel):
    name: str | None = None
    color: str | None = None


class SetEventFolderRequest(BaseModel):
    folderId: str | None = None
