from datetime import datetime
from enum import Enum

from pydantic import BaseModel, EmailStr, Field


class EventType(str, Enum):
    """일정은 한 종류뿐입니다 - 고른 날짜에 대해 가능한 시간을 모읍니다.

    예전에는 요일 반복("dow")과 초대 전용 그룹("group")이 더 있었는데,
    반복 일정을 쓸 일이 없어 걷어냈습니다. 값은 그대로 두어 이미 저장된
    문서를 읽는 데 문제가 없게 합니다 - 새로 만들 때만 이 하나입니다.
    """

    SPECIFIC_DATES = "specific_dates"


class EventPayload(BaseModel):
    """Shared shape for create + edit."""

    name: str = Field(min_length=1)
    description: str | None = None
    # "markdown" renders through the in-app viewer; anything else is shown
    # as plain text with line breaks preserved.
    descriptionFormat: str = "text"
    duration: float = Field(gt=0)
    dates: list[datetime] = Field(min_length=1)
    type: EventType

    startOnMonday: bool = False
    notificationsEnabled: bool = False
    blindAvailabilityEnabled: bool = False
    collectEmails: bool = False
    timeIncrement: int = 15
    sendEmailAfterXResponses: int | None = None

    remindees: list[str] = Field(default_factory=list)


class EventResponsePayload(BaseModel):
    availability: list[datetime] = Field(default_factory=list)
    ifNeeded: list[datetime] = Field(default_factory=list)

    guest: bool
    name: str | None = None
    email: str | None = None

    useCalendarAvailability: bool | None = None
    enabledCalendars: dict[str, list[str]] | None = None
    # Keyed by ISO date string (a whole day), value = that day's specific available times.
    manualAvailability: dict[str, list[datetime]] | None = None


class DeleteResponsePayload(BaseModel):
    userId: str | None = None
    guest: bool
    name: str | None = None


class RenameGuestPayload(BaseModel):
    oldName: str
    newName: str


class UserRespondedPayload(BaseModel):
    email: str


class DuplicateEventPayload(BaseModel):
    eventName: str = Field(min_length=1)
    copyAvailability: bool = False


class SendInvitePayload(BaseModel):
    # Capped to keep this from being usable as a bulk mailer.
    emails: list[EmailStr] = Field(min_length=1, max_length=20)
    message: str = Field(default="", max_length=500)
