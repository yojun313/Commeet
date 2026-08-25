"""Sends notification emails over SMTP.

`MAIL_BACKEND` picks the route (see app/config.py): `gmail` logs in to
smtp.gmail.com with an app password, `postech` relays through
smtp.postech.ac.kr without any credentials - the POSTECH mail admin authorises
that relay by server IP, so it only works when deployed on the registered host.
When the chosen backend isn't configured the email is logged to the console
instead of sent, so the rest of the app never has to special-case
"mail isn't set up".
"""

import asyncio
import logging
import os
import smtplib
from datetime import datetime
from email.header import Header
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from zoneinfo import ZoneInfo

from app.config import (
    APP_NAME,
    BASE_URL,
    MAIL_BACKEND,
    MAIL_ENABLED,
    MAIL_PASSWORD,
    MAIL_REPLY_TO,
    MAIL_SENDER,
    MAIL_STARTTLS,
    MAIL_TIMEOUT,
    OTP_TTL_MINUTES,
    POSTECH_SMTP_HOST,
    POSTECH_SMTP_PORT,
)

logger = logging.getLogger("commeet.email")

# Meeting times are written in Korea time - every user of this service is local.
MEETING_TZ = ZoneInfo("Asia/Seoul")


def _smtp_target() -> tuple[str, int]:
    if MAIL_BACKEND == "postech":
        return POSTECH_SMTP_HOST, POSTECH_SMTP_PORT
    return "smtp.gmail.com", 587


def _deliver(sender: str, receiver: str, msg) -> None:
    """Hands the message to whichever SMTP server MAIL_BACKEND selects."""
    if MAIL_BACKEND not in ("gmail", "postech"):
        raise ValueError(
            f"Unknown MAIL_BACKEND {MAIL_BACKEND!r} (expected 'gmail' or 'postech')"
        )

    host, port = _smtp_target()
    with smtplib.SMTP(host, port, timeout=MAIL_TIMEOUT) as server:
        if MAIL_BACKEND == "postech":
            # No login: the relay authorises this server by its IP address.
            server.ehlo()
            if MAIL_STARTTLS and server.has_extn("starttls"):
                server.starttls()
                server.ehlo()
        else:
            server.starttls()
            server.login(sender, MAIL_PASSWORD)
        server.sendmail(sender, receiver, msg.as_string())


def send_email(receiver, title, text, file_path=None, sender_name=None):
    sender = MAIL_SENDER

    # 이메일 메시지 생성
    msg = MIMEMultipart()
    msg["Subject"] = title
    # 받는 사람 메일함에 계정 주소 대신 보낸 사람 이름이 보이도록 표시 이름을 붙임
    msg["From"] = (
        formataddr((str(Header(sender_name, "utf-8")), sender))
        if sender_name
        else sender
    )
    msg["To"] = receiver
    # 발신 전용 주소로 보낼 때 회신이 갈 곳을 지정해 둔다
    if MAIL_REPLY_TO:
        msg["Reply-To"] = MAIL_REPLY_TO

    # 이메일 본문 추가
    msg.attach(MIMEText(text, "plain"))

    # 파일 첨부 (file_path가 제공된 경우)
    if file_path and os.path.exists(file_path):
        with open(file_path, "rb") as f:
            file_attachment = MIMEApplication(
                f.read(), Name=os.path.basename(file_path)
            )
            file_attachment["Content-Disposition"] = (
                f'attachment; filename="{os.path.basename(file_path)}"'
            )
            msg.attach(file_attachment)

    _deliver(sender, receiver, msg)


async def _send(to: str, title: str, text: str, sender_name: str | None = None) -> None:
    """Async wrapper: `send_email` blocks on the network, so it runs in a
    worker thread to keep the event loop responsive."""
    if not to:
        return
    if not MAIL_ENABLED:
        logger.info("[메일 미설정 - 발송 생략] to=%s subject=%s", to, title)
        return

    try:
        await asyncio.to_thread(
            send_email, to, title, text, None, sender_name or APP_NAME
        )
    except Exception:
        logger.exception("Failed to send email to %s", to)


def _owner_name(owner: dict | None) -> str:
    if not owner:
        return "누군가"
    return owner.get("name") or "누군가"


def _event_url(event: dict) -> str:
    kind = "g" if event.get("type") == "group" else "e"
    return f"{BASE_URL}/{kind}/{event.get('shortId') or event['_id']}"


async def send_verification_code_email(to: str, code: str) -> None:
    if not MAIL_ENABLED:
        # Without mail configured the code would be unreachable and sign-up
        # impossible, so surface it on the console for local development only.
        logger.warning("[메일 미설정] %s 인증 코드: %s", to, code)

    await _send(
        to,
        f"[{APP_NAME}] 회원가입 인증 코드",
        f"{APP_NAME} 회원가입 인증 코드입니다: {code}\n\n"
        f"이 코드는 {OTP_TTL_MINUTES}분 후에 만료됩니다.\n"
        f"본인이 요청하지 않았다면 이 메일은 무시하셔도 됩니다.\n",
    )


def _host_sender_name(owner: dict | None) -> str:
    """Invites come *from the host*, so their name leads the From header."""
    return f"{_owner_name(owner)} ({APP_NAME})"


async def send_event_invite_email(
    to: str, owner: dict | None, event: dict, message: str = ""
) -> None:
    host = _owner_name(owner)
    body = f"{host}님이 회원님을 일정 '{event['name']}'에 초대했습니다.\n\n"
    if message:
        body += f"{host}님의 메시지:\n{message}\n\n"
    body += f"아래 링크에서 가능한 시간을 표시해 주세요.\n{_event_url(event)}\n"

    await _send(
        to,
        f"[{APP_NAME}] {host}님이 '{event['name']}' 일정에 초대했습니다",
        body,
        _host_sender_name(owner),
    )


async def send_group_invite_email(
    to: str, owner: dict | None, event: dict, message: str = ""
) -> None:
    host = _owner_name(owner)
    body = f"{host}님이 회원님을 그룹 '{event['name']}'에 초대했습니다.\n\n"
    if message:
        body += f"{host}님의 메시지:\n{message}\n\n"
    body += f"아래 링크에서 가능한 시간을 표시해 주세요.\n{_event_url(event)}\n"

    await _send(
        to,
        f"[{APP_NAME}] {host}님이 '{event['name']}' 그룹에 초대했습니다",
        body,
        _host_sender_name(owner),
    )


async def send_someone_responded_email(
    owner: dict, event: dict, respondent_name: str
) -> None:
    await _send(
        owner.get("email", ""),
        f"[{APP_NAME}] {respondent_name}님이 '{event['name']}'에 응답했습니다",
        f"안녕하세요 {_owner_name(owner)}님,\n\n"
        f"{respondent_name}님이 '{event['name']}'에 가능한 시간을 등록했습니다.\n\n"
        f"결과 확인하기: {_event_url(event)}\n",
    )


async def send_threshold_reached_email(
    owner: dict, event: dict, num_responses: int
) -> None:
    await _send(
        owner.get("email", ""),
        f"[{APP_NAME}] '{event['name']}'에 {num_responses}명이 응답했습니다",
        f"안녕하세요 {_owner_name(owner)}님,\n\n"
        f"'{event['name']}'에 벌써 {num_responses}명이 응답했습니다!\n\n"
        f"결과 확인하기: {_event_url(event)}\n",
    )


def _format_meeting_time(start: datetime, end: datetime | None = None) -> str:
    """Renders a meeting slot in the host's local wall time."""
    local_start = start.astimezone(MEETING_TZ)
    weekday = "월화수목금토일"[local_start.weekday()]
    text = f"{local_start.year}년 {local_start.month}월 {local_start.day}일({weekday}) {local_start:%H:%M}"
    if end is not None:
        text += f" ~ {end.astimezone(MEETING_TZ):%H:%M}"
    return text


async def send_meeting_confirmed_email(
    to: str,
    host: dict | None,
    event: dict,
    start: datetime,
    end: datetime,
    other_names: list[str],
    *,
    updated: bool = False,
) -> None:
    host_name = _owner_name(host)
    headline = "일정이 변경되었습니다" if updated else "일정이 확정되었습니다"

    body = f"'{event['name']}' {headline}.\n\n"
    body += f"■ 일시: {_format_meeting_time(start, end)}\n"
    if other_names:
        body += f"■ 함께하는 분: {', '.join(other_names)}\n"
    body += f"■ 주최: {host_name}님\n\n"
    body += f"자세한 내용은 아래 링크에서 확인하실 수 있습니다.\n{_event_url(event)}\n"

    await _send(
        to,
        f"[{APP_NAME}] '{event['name']}' {headline}",
        body,
        _host_sender_name(host),
    )


async def send_meeting_unassigned_email(
    to: str, host: dict | None, event: dict
) -> None:
    await _send(
        to,
        f"[{APP_NAME}] '{event['name']}' 일정 배정 안내",
        f"'{event['name']}' 일정이 확정되었지만, 아쉽게도 회원님과 맞는 시간을 찾지 못했습니다.\n\n"
        f"주최자({_owner_name(host)}님)에게 문의해 주세요.\n{_event_url(event)}\n",
        _host_sender_name(host),
    )


async def send_meeting_cancelled_email(
    to: str, host: dict | None, event: dict, start: datetime
) -> None:
    await _send(
        to,
        f"[{APP_NAME}] '{event['name']}' 일정 확정이 취소되었습니다",
        f"'{event['name']}' 일정 확정이 취소되었습니다.\n\n"
        f"■ 취소된 일시: {_format_meeting_time(start)}\n\n"
        f"다시 확정되면 새로 안내드리겠습니다.\n{_event_url(event)}\n",
        _host_sender_name(host),
    )


class MailNotConfigured(Exception):
    """Raised by send_test_email when no mail backend is usable."""


async def send_test_email(to: str) -> dict:
    """Admin mail-test. Unlike `_send`, this deliberately lets SMTP errors
    propagate instead of logging and moving on, so the dashboard can show
    the operator exactly why delivery failed."""
    if not MAIL_ENABLED:
        raise MailNotConfigured(
            f"메일이 설정되어 있지 않습니다 (MAIL_BACKEND={MAIL_BACKEND}). "
            "콘솔 로그로만 출력됩니다."
        )

    sent_at = datetime.now(MEETING_TZ).strftime("%Y-%m-%d %H:%M:%S")
    body = (
        f"{APP_NAME} 메일 발송 테스트입니다.\n\n"
        f"이 메일이 도착했다면 서버의 메일 설정이 정상입니다.\n\n"
        f"- 발송 시각: {sent_at} (KST)\n"
        f"- 백엔드: {MAIL_BACKEND}\n"
        f"- 보내는 주소: {MAIL_SENDER}\n"
        f"- 서버: {BASE_URL}\n"
    )
    await asyncio.to_thread(
        send_email, to, f"[{APP_NAME}] 메일 발송 테스트", body, None, APP_NAME
    )
    return {
        "backend": MAIL_BACKEND,
        "sender": MAIL_SENDER,
        "host": _smtp_target()[0],
        "port": _smtp_target()[1],
        "sentAt": sent_at,
    }
