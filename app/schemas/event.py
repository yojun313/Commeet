from datetime import datetime
from enum import Enum

from pydantic import BaseModel, EmailStr, Field


class EventType(str, Enum):
    SPECIFIC_DATES = "specific_dates"
    DOW = "dow"
    GROUP = "group"


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

    # Event type only
    remindees: list[str] = Field(default_factory=list)

    # Group type only
    attendees: list[str] = Field(default_factory=list)


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
