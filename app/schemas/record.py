from datetime import datetime

from pydantic import BaseModel, Field


class AttendeeInput(BaseModel):
    key: str = ""
    name: str = ""
    email: str = ""
    studentId: str = ""
    # 학생지도비 rate depends on this, so the host can correct the guess.
    affiliation: str = "cse"
    present: bool = True


class SettlementInput(BaseModel):
    affiliation: str = "cse"
    headcount: int = 0
    unitPrice: int = 0
    amount: int = 0
    receiptTime: str = ""
    receiptFile: str | None = None
    receiptName: str = ""


class NoteFields(BaseModel):
    """면담 내용을 네 갈래로 나눠 적습니다.

    예전에는 자유 서술 한 칸이었습니다. POVIS 지도 기록이 이 네 항목을
    따로 요구해서, 한 칸에 몰아 쓴 다음 옮겨 적어야 했습니다.
    """

    academic: str = ""  # 학업지도
    life: str = ""  # 생활지도
    career: str = ""  # 진로지도
    etc: str = ""  # 기타사항


class SaveRecordRequest(BaseModel):
    eventId: str
    meetingStart: datetime
    date: str = ""
    startTime: str = ""
    endTime: str = ""
    place: str = ""
    professorName: str = ""
    attendees: list[AttendeeInput] = Field(default_factory=list)
    # "shared" applies one set of notes to everyone; "individual" keeps
    # a separate set per student (perStudentNotes).
    notesMode: str = "shared"
    sharedNotes: NoteFields = Field(default_factory=NoteFields)
    perStudentNotes: dict[str, NoteFields] = Field(default_factory=dict)
    settlements: list[SettlementInput] = Field(default_factory=list)
    status: str = "draft"


class SignatureRequest(BaseModel):
    """The drawn signature, as the canvas `toDataURL()` string."""

    dataUrl: str
