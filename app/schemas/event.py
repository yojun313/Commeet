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

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=10000)
    # "markdown" renders through the in-app viewer; anything else is shown
    # as plain text with line breaks preserved.
    descriptionFormat: str = "text"
    duration: float = Field(gt=0)
    # 하루 1열이므로 1년치도 수십 개 - 그 이상은 실수이거나 공격입니다.
    dates: list[datetime] = Field(min_length=1, max_length=120)
    type: EventType

    startOnMonday: bool = False
    notificationsEnabled: bool = False
    blindAvailabilityEnabled: bool = False
    collectEmails: bool = False
    # 지도 면담 기능. 켜면 일정 페이지에 "면담 기록 · 학생지도비" 칸이 생깁니다.
    # 값이 **없는** 예전 일정은 켜진 것으로 봅니다 (records_enabled 참고) -
    # 이 항목이 생기기 전에 적어 둔 기록이 사라지면 안 됩니다.
    guidanceRecordsEnabled: bool = False
    timeIncrement: int = Field(default=15, ge=5, le=120)
    sendEmailAfterXResponses: int | None = None

    remindees: list[str] = Field(default_factory=list, max_length=300)


class EventResponsePayload(BaseModel):
    # 15분 간격 x 12시간 x 120일 = 5,760칸이 물리적 상한 근처입니다.
    availability: list[datetime] = Field(default_factory=list, max_length=8000)
    ifNeeded: list[datetime] = Field(default_factory=list, max_length=8000)

    guest: bool
    name: str | None = Field(default=None, max_length=100)
    email: str | None = Field(default=None, max_length=254)

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
    eventName: str = Field(min_length=1, max_length=200)
    copyAvailability: bool = False


class SendInvitePayload(BaseModel):
    # Capped to keep this from being usable as a bulk mailer.
    emails: list[EmailStr] = Field(min_length=1, max_length=20)
    message: str = Field(default="", max_length=500)


class SendMessagePayload(BaseModel):
    """주최자가 참가자에게 보내는 짧은 안내 (응답 재촉 등).

    인원 상한은 초대와 같습니다 - 이 앱이 대량 발송 도구로 쓰이지 않게.
    """

    emails: list[EmailStr] = Field(min_length=1, max_length=20)
    message: str = Field(default="", max_length=1000)
    # 비우면 기본 제목("[APP] '일정' 안내")을 씁니다.
    subject: str = Field(default="", max_length=200)
    # True면 전체 수신자를 To에 나란히 넣은 **한 통**을 보내고 주최자를
    # 참조(Cc)합니다 - 받는 사람들이 서로를 보고 전체 답장할 수 있습니다.
    # False면 지금까지처럼 한 사람당 한 통씩 따로 갑니다.
    combined: bool = True
