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
    # 확정 안내 메일에 캘린더 초대(.ics)를 첨부할지. 받는 쪽 메일 앱이
    # 수락/거절 버튼을 그려 주고, 수락하면 캘린더에 등록됩니다.
    calendarInvite: bool = True
