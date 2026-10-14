from pydantic import BaseModel, Field


class CoHostPrefRequest(BaseModel):
    """일정 창에서 바꾼 공동주최자 한 명의 권한 체크 (다음에 다시 채우려고 기억)."""

    email: str = Field(min_length=3, max_length=254)
    perms: dict[str, bool]


class UpdateNameRequest(BaseModel):
    name: str = Field(min_length=1)


class ChangePasswordRequest(BaseModel):
    currentPassword: str
    newPassword: str = Field(min_length=8)


class BufferTimeOptions(BaseModel):
    enabled: bool
    time: int = 15


class WorkingHoursOptions(BaseModel):
    enabled: bool
    startTime: float = 9
    endTime: float = 17


class UpdateCalendarOptionsRequest(BaseModel):
    bufferTime: BufferTimeOptions | None = None
    workingHours: WorkingHoursOptions | None = None


class ToggleCalendarRequest(BaseModel):
    email: str
    enabled: bool


class ToggleSubCalendarRequest(BaseModel):
    email: str
    subCalendarId: str
    enabled: bool


class RemoveCalendarAccountRequest(BaseModel):
    email: str


class DeleteAccountRequest(BaseModel):
    email: str
