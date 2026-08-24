"""Sends notification emails through Gmail SMTP.

`send_email` is the same function used in the pcss project, with the sender
credentials read from the environment (MAIL_SENDER / MAIL_PASSWORD) instead
of a JSON file. When those are unset the email is logged to the console
instead of sent, so the rest of the app never has to special-case
"mail isn't set up".
"""

import asyncio
import logging
import os
import smtplib
from email.header import Header
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

from app.config import (
    APP_NAME,
    BASE_URL,
    MAIL_ENABLED,
    MAIL_PASSWORD,
    MAIL_SENDER,
    OTP_TTL_MINUTES,
)

logger = logging.getLogger("pcts.email")


def send_email(receiver, title, text, file_path=None, sender_name=None):
    sender = MAIL_SENDER
    MailPassword = MAIL_PASSWORD

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

    smtp_server = "smtp.gmail.com"
    smtp_port = 587

    # SMTP 연결 및 메일 보내기
    with smtplib.SMTP(smtp_server, smtp_port) as server:
        server.starttls()
        server.login(sender, MailPassword)
        server.sendmail(sender, receiver, msg.as_string())


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
