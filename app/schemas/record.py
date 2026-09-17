from datetime import datetime

from pydantic import BaseModel, Field


class AttendeeInput(BaseModel):
    key: str = Field(default="", max_length=200)
    name: str = Field(default="", max_length=100)
    email: str = Field(default="", max_length=254)
    studentId: str = Field(default="", max_length=40)
    # 학생지도비 rate depends on this, so the host can correct the guess.
    affiliation: str = "cse"
    present: bool = True


class SettlementLine(BaseModel):
    """신청서 한 장 안의 단가 줄. 무은재생은 컴공·무은재 양쪽에서 절반씩
    지원받아 컴공 신청서에 단가가 두 종류(3만/1.5만) 섞이므로, 단가×인원을
    줄 단위로 둡니다."""

    label: str = ""
    unitPrice: int = 0
    headcount: int = 0


class SettlementInput(BaseModel):
    # affiliation은 이제 "제출처"입니다 - cse면 컴공에 내는 신청서.
    affiliation: str = "cse"
    headcount: int = 0
    unitPrice: int = 0  # 단가가 한 종류일 때만 의미. 섞이면 lines를 보세요.
    amount: int = 0
    capAmount: int = 0  # 상한 (lines 합). 실제 집행액(amount)은 이하로 조정 가능.
    lines: list[SettlementLine] = Field(default_factory=list)
    receiptTime: str = ""
    receiptFile: str | None = None
    receiptName: str = ""


class NoteFields(BaseModel):
    """면담 내용을 네 갈래로 나눠 적습니다.

    예전에는 자유 서술 한 칸이었습니다. POVIS 지도 기록이 이 네 항목을
    따로 요구해서, 한 칸에 몰아 쓴 다음 옮겨 적어야 했습니다.
    """

    academic: str = Field(default="", max_length=20000)  # 학업지도
    life: str = Field(default="", max_length=20000)  # 생활지도
    career: str = Field(default="", max_length=20000)  # 진로지도
    etc: str = Field(default="", max_length=20000)  # 기타사항


class SaveRecordRequest(BaseModel):
    eventId: str
    meetingStart: datetime
    date: str = ""
    startTime: str = ""
    endTime: str = ""
    place: str = ""
    professorName: str = ""
    attendees: list[AttendeeInput] = Field(default_factory=list, max_length=100)
    # "shared" applies one set of notes to everyone; "individual" keeps
    # a separate set per student (perStudentNotes).
    notesMode: str = "shared"
    sharedNotes: NoteFields = Field(default_factory=NoteFields)
    perStudentNotes: dict[str, NoteFields] = Field(default_factory=dict)
    settlements: list[SettlementInput] = Field(default_factory=list, max_length=6)
    status: str = "draft"


class SignatureRequest(BaseModel):
    """The drawn signature, as the canvas `toDataURL()` string."""

    dataUrl: str
