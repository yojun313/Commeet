from datetime import datetime

from pydantic import BaseModel, Field


class ProposalRequest(BaseModel):
    # 1 = one-on-one meetings; N = up to N people per meeting.
    capacity: int = Field(default=1, ge=1, le=100)
    meetingMinutes: int = Field(default=30, ge=5, le=1440)
    allowIfNeeded: bool = True


class MeetingInput(BaseModel):
    start: datetime
    participants: list[str] = Field(default_factory=list)


class ConfirmRequest(BaseModel):
    capacity: int = Field(default=1, ge=1, le=100)
    meetingMinutes: int = Field(default=30, ge=5, le=1440)
    meetings: list[MeetingInput] = Field(default_factory=list)
