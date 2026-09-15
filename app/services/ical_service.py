"""확정 안내 메일에 붙는 iCalendar(.ics) 초대.

표준 iCalendar(METHOD:REQUEST)라서 Gmail·Outlook·Apple Mail이 메일 안에
일정 카드와 수락/거절 버튼을 자체 표시하고, 수락하면 받는 사람 캘린더에
등록됩니다 - 외부 API도, 받는 사람 쪽 설정도 필요 없습니다.

핵심은 **같은 일정을 다시 보낼 때 새 항목이 생기지 않게** 하는 것입니다:

  - UID는 (일정, 참석자)마다 고정입니다. 한 사람은 한 일정에서 약속을
    하나만 가지므로(confirm이 중복 배정을 거부), 재확정으로 시간이 바뀌면
    같은 UID에 새 시간이 온 것이 되어 캘린더 항목이 **갱신**됩니다.
  - SEQUENCE는 확정 시각(epoch 초)입니다 - 보낼 때마다 단조 증가해야
    클라이언트가 "더 새 버전"으로 받아들이는데, 따로 세지 않아도 시각이
    그 성질을 공짜로 줍니다.
  - 배정에서 빠진 사람에게는 METHOD:CANCEL(같은 UID)을 보내 캘린더에서
    지워지게 합니다.
"""

from datetime import datetime

from app.config import APP_NAME, MAIL_SENDER


def _fmt_utc(dt: datetime) -> str:
    return dt.strftime("%Y%m%dT%H%M%SZ")


def _escape(text: str) -> str:
    """iCalendar TEXT 이스케이프 (백슬래시·세미콜론·쉼표·줄바꿈)."""
    return (
        (text or "")
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def _fold(line: str) -> str:
    """75옥텟 줄 접기 (RFC 5545 §3.1). 긴 DESCRIPTION에서 깨지는 클라이언트가
    있어 스펙대로 접습니다 - 이어지는 줄은 공백 하나로 시작합니다."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    parts = []
    while raw:
        cut = min(75, len(raw))
        # 멀티바이트(한글) 문자를 반으로 자르지 않게 경계를 뒤로 물립니다.
        while cut < len(raw) and (raw[cut] & 0xC0) == 0x80:
            cut -= 1
        parts.append(raw[:cut].decode("utf-8"))
        raw = raw[cut:]
    return "\r\n ".join(parts)


def event_uid(event_id: str, attendee_key: str) -> str:
    """(일정, 참석자)마다 고정인 UID. 재확정 갱신의 열쇠입니다."""
    # attendee_key에는 게스트 이름(한글·공백)이 올 수 있는데, UID는 어떤
    # 클라이언트가 파싱할지 모르니 ASCII 영숫자만 남기고 코드포인트로 풉니다.
    # (한글은 str.isalnum()이 True라 isascii() 확인이 꼭 필요합니다.)
    safe = "".join(
        c if c.isascii() and c.isalnum() else f"-{ord(c):x}" for c in attendee_key
    )
    return f"commeet-{event_id}-{safe}@commeet"


def build_ics(
    *,
    method: str,  # "REQUEST" (초대/변경) 또는 "CANCEL" (배정 해제)
    uid: str,
    sequence: int,
    start: datetime,
    end: datetime,
    summary: str,
    description: str = "",
    location: str = "",
    organizer_name: str = "",
    attendee_name: str = "",
    attendee_email: str = "",
    stamp: datetime | None = None,
) -> str:
    lines = [
        "BEGIN:VCALENDAR",
        f"PRODID:-//{APP_NAME}//KO",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        f"METHOD:{method}",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"SEQUENCE:{sequence}",
        f"DTSTAMP:{_fmt_utc(stamp or start)}",
        f"DTSTART:{_fmt_utc(start)}",
        f"DTEND:{_fmt_utc(end)}",
        f"SUMMARY:{_escape(summary)}",
    ]
    if description:
        lines.append(f"DESCRIPTION:{_escape(description)}")
    if location:
        lines.append(f"LOCATION:{_escape(location)}")
    # ORGANIZER는 발송 계정이어야 합니다 - 보낸 주소와 다르면 Gmail이 초대
    # 카드를 그리지 않는 경우가 있습니다. 주최자 이름은 CN으로 보입니다.
    lines.append(
        f'ORGANIZER;CN="{_escape(organizer_name or APP_NAME)}":mailto:{MAIL_SENDER}'
    )
    if attendee_email:
        lines.append(
            f'ATTENDEE;CN="{_escape(attendee_name or attendee_email)}";ROLE=REQ-PARTICIPANT;'
            f"PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{attendee_email}"
        )
    lines.append("STATUS:CANCELLED" if method == "CANCEL" else "STATUS:CONFIRMED")
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"
