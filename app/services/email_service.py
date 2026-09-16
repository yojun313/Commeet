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
import time
from collections.abc import Sequence
from contextlib import contextmanager
from dataclasses import dataclass
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
    MAIL_DNS_TIMEOUT,
    MAIL_ENABLED,
    MAIL_MAX_CONNECTIONS,
    MAIL_PASSWORD,
    MAIL_REPLY_TO,
    MAIL_SENDER,
    MAIL_STARTTLS,
    MAIL_TIMEOUT,
    MAIL_VERIFY_DOMAIN,
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


# ---------------------------------------------------------------------------
# 받을 수 없는 주소 걸러내기
# ---------------------------------------------------------------------------

# RFC 2606 / 6761 / 6762 - 실제 메일이 배달될 수 없도록 예약된 이름들.
# DNS를 물어볼 필요가 없고, 물어봐도 도움이 안 됩니다: .local은 mDNS용이라
# 조회하면 NXDOMAIN이 아니라 NoNameservers가 돌아와 "일시적 장애"로
# 오해되기 쉽습니다. 그래서 이름만 보고 먼저 끊어 냅니다.
_RESERVED_TLDS = frozenset({"test", "example", "invalid", "localhost", "local"})
_RESERVED_DOMAINS = frozenset({"example.com", "example.net", "example.org"})

# 도메인 하나를 여러 수신자가 공유하므로(같은 학교 메일 등) 결과를 잠깐
# 재사용합니다. 34명에게 보낼 때 DNS를 34번 물어볼 이유가 없습니다.
_DOMAIN_CACHE_TTL = 600.0
_domain_cache: dict[str, tuple[bool, float]] = {}


def _domain_of(address: str) -> str:
    return address.rsplit("@", 1)[-1].strip().lower().rstrip(".")


def is_reserved_domain(address: str) -> bool:
    """절대 배달될 수 없는 예약 도메인인지. DNS 없이 판단합니다."""
    domain = _domain_of(address)
    if not domain:
        return True
    if domain in _RESERVED_DOMAINS:
        return True
    return domain.rsplit(".", 1)[-1] in _RESERVED_TLDS


def _domain_accepts_mail(domain: str) -> bool:
    """MX(없으면 A/AAAA) 레코드가 있는지.

    **판단이 서지 않으면 True를 돌려줍니다.** DNS 타임아웃이나 리졸버 장애로
    진짜 메일이 조용히 사라지는 것이, 없는 주소에 한 번 더 시도하는 것보다
    훨씬 나쁩니다. 확실히 없다고 말할 수 있을 때만 False입니다.
    """
    import dns.exception
    import dns.resolver

    now = time.monotonic()
    cached = _domain_cache.get(domain)
    if cached and now - cached[1] < _DOMAIN_CACHE_TTL:
        return cached[0]

    ok = True
    try:
        dns.resolver.resolve(domain, "MX", lifetime=MAIL_DNS_TIMEOUT)
    except dns.resolver.NXDOMAIN:
        ok = False  # 도메인 자체가 없음
    except dns.resolver.NoAnswer:
        # MX가 없어도 A/AAAA가 있으면 그 호스트가 메일을 받습니다 (RFC 5321).
        try:
            dns.resolver.resolve(domain, "A", lifetime=MAIL_DNS_TIMEOUT)
        except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
            ok = False
        except dns.exception.DNSException:
            ok = True  # 확신할 수 없으면 보냄
    except dns.exception.DNSException:
        ok = True  # 타임아웃·NoNameservers 등 - 확신할 수 없으면 보냄

    _domain_cache[domain] = (ok, now)
    return ok


def _filter_reserved(mails: Sequence["Mail"]) -> list["Mail"]:
    """예약 도메인을 걸러 냅니다 (DNS 없이 즉시)."""
    kept, skipped = [], []
    for mail in mails:
        (skipped if is_reserved_domain(mail.to) else kept).append(mail)
    if skipped:
        logger.info(
            "[받을 수 없는 도메인 - 발송 생략] %d건: %s",
            len(skipped),
            ", ".join(m.to for m in skipped[:5]),
        )
    return kept


def _filter_undeliverable(mails: list["Mail"]) -> list["Mail"]:
    """도메인이 메일을 받을 수 있는지 DNS로 확인해 거릅니다 (블로킹)."""
    if not MAIL_VERIFY_DOMAIN:
        return mails
    kept, skipped = [], []
    for mail in mails:
        (kept if _domain_accepts_mail(_domain_of(mail.to)) else skipped).append(mail)
    if skipped:
        logger.info(
            "[존재하지 않는 도메인 - 발송 생략] %d건: %s",
            len(skipped),
            ", ".join(m.to for m in skipped[:5]),
        )
    return kept


@dataclass(frozen=True)
class Mail:
    """보낼 메일 한 통. 여러 명에게 보낼 때는 이 목록을 만들어
    `send_many()`에 한 번에 넘깁니다.

    `extra_to`/`cc`는 **같은 한 통**을 함께 받는 사람들입니다 - "하나의
    메일로 발송"처럼 수신자 전원이 서로를 보고 전체 답장할 수 있어야 할 때
    씁니다. 서로 몰라야 하면 지금처럼 Mail을 사람 수만큼 만드세요.
    """

    to: str
    subject: str
    body: str
    sender_name: str | None = None
    extra_to: tuple[str, ...] = ()
    cc: tuple[str, ...] = ()
    # iCalendar 초대(.ics). 넣으면 text/calendar 파트로 함께 나가고, Gmail 등이
    # 메일 안에 일정 카드(수락/거절)를 그립니다. method는 REQUEST/CANCEL.
    ics: str | None = None
    ics_method: str = "REQUEST"


def _recipients(mail: Mail) -> list[str]:
    """SMTP 봉투에 넣을 실제 수신자 전원 (To + extra_to + Cc)."""
    return [mail.to, *mail.extra_to, *mail.cc]


@contextmanager
def _smtp_session():
    """SMTP 연결 하나를 열어 둡니다.

    접속·STARTTLS·로그인은 메일 한 통을 실제로 보내는 것보다 훨씬 오래
    걸리므로, 여러 통을 보낼 때 이 세션을 재사용하는 것이 가장 큰
    속도 차이를 만듭니다.
    """
    if MAIL_BACKEND not in ("gmail", "postech"):
        raise ValueError(
            f"Unknown MAIL_BACKEND {MAIL_BACKEND!r} (expected 'gmail' or 'postech')"
        )

    host, port = _smtp_target()
    server = smtplib.SMTP(host, port, timeout=MAIL_TIMEOUT)
    try:
        if MAIL_BACKEND == "postech":
            # No login: the relay authorises this server by its IP address.
            server.ehlo()
            if MAIL_STARTTLS and server.has_extn("starttls"):
                server.starttls()
                server.ehlo()
        else:
            server.starttls()
            server.login(MAIL_SENDER, MAIL_PASSWORD)
        yield server
    finally:
        try:
            server.quit()
        except smtplib.SMTPException:
            server.close()


def _deliver(sender: str, receiver: str, msg) -> None:
    """메일 한 통을 자기 연결로 보냅니다 (단발 발송용)."""
    with _smtp_session() as server:
        server.sendmail(sender, receiver, msg.as_string())


# 수신자 한 명의 문제라 연결은 살아 있는 오류들. 나머지 수신자에게는
# 계속 보내야 하므로 여기서 걸러 기록만 남깁니다.
_PER_RECIPIENT_ERRORS = (
    smtplib.SMTPRecipientsRefused,
    smtplib.SMTPSenderRefused,
    smtplib.SMTPDataError,
    smtplib.SMTPNotSupportedError,
)


def _deliver_batch(mails: list[Mail]) -> list[tuple[str, Exception]]:
    """한 연결로 여러 통을 이어서 보내고, 실패한 (수신자, 오류)를 돌려줍니다.

    연결이 도중에 끊기면 남은 메일만 새 연결로 한 번 더 시도합니다 -
    묶어 보내는 대신 한 명이 실패했다고 나머지가 통째로 날아가면 안 됩니다.
    """
    remaining = list(mails)
    failures: list[tuple[str, Exception]] = []

    for attempt in (1, 2):
        if not remaining:
            break
        try:
            with _smtp_session() as server:
                while remaining:
                    mail = remaining[0]
                    try:
                        server.sendmail(
                            MAIL_SENDER,
                            _recipients(mail),
                            _build_message(mail).as_string(),
                        )
                    except _PER_RECIPIENT_ERRORS as exc:
                        failures.append((mail.to, exc))
                    remaining.pop(0)
        except (smtplib.SMTPException, OSError) as exc:
            # 연결이 끊겼거나 처음부터 붙지 못함. 두 번째도 실패하면 포기.
            if attempt == 2:
                failures.extend((m.to, exc) for m in remaining)
                remaining = []

    return failures


def _build_message(mail: Mail, file_path: str | None = None) -> MIMEMultipart:
    sender = MAIL_SENDER

    msg = MIMEMultipart()
    msg["Subject"] = mail.subject
    # 받는 사람 메일함에 계정 주소 대신 보낸 사람 이름이 보이도록 표시 이름을 붙임
    msg["From"] = (
        formataddr((str(Header(mail.sender_name, "utf-8")), sender))
        if mail.sender_name
        else sender
    )
    msg["To"] = ", ".join([mail.to, *mail.extra_to])
    if mail.cc:
        msg["Cc"] = ", ".join(mail.cc)
    # 발신 전용 주소로 보낼 때 회신이 갈 곳을 지정해 둔다
    if MAIL_REPLY_TO:
        msg["Reply-To"] = MAIL_REPLY_TO

    msg.attach(MIMEText(mail.body, "plain"))

    if mail.ics:
        # Gmail이 초대 카드를 그리려면 content-type이 text/calendar이고
        # method 파라미터가 있어야 합니다. 파일명은 다른 클라이언트에서
        # 첨부로 저장할 때를 위한 것입니다.
        cal = MIMEText(mail.ics, "calendar", "utf-8")
        cal.set_param("method", mail.ics_method)
        cal.add_header("Content-Disposition", 'attachment; filename="invite.ics"')
        msg.attach(cal)

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

    return msg


def send_email(receiver, title, text, file_path=None, sender_name=None):
    """동기 단발 발송. 첨부파일을 붙일 수 있는 유일한 경로입니다."""
    mail = Mail(to=receiver, subject=title, body=text, sender_name=sender_name)
    _deliver(MAIL_SENDER, receiver, _build_message(mail, file_path))


async def send_many(mails: Sequence[Mail]) -> None:
    """여러 통을 동시에 보냅니다.

    수신자를 MAIL_MAX_CONNECTIONS개로 나눠, 각 몫을 **자기 연결 하나로 이어서**
    보냅니다. 통마다 연결을 새로 열던 이전 방식과 비교하면 두 가지가 줄어듭니다:
    접속·로그인 횟수(N -> 연결 수)와 대기 시간(순차 -> 동시).

    동시 연결 수를 제한하는 이유는 구글 캘린더 대량 삭제 때와 같습니다 -
    한꺼번에 수십 개를 열면 메일 서버가 조용히 거절하거나 스팸으로 봅니다.

    발송 실패는 로그로만 남깁니다. 확정/초대 같은 본래 작업이 메일 때문에
    실패하면 안 되기 때문입니다.
    """
    pending = _filter_reserved([m for m in mails if m.to])
    if not pending:
        return

    if not MAIL_ENABLED:
        for mail in pending:
            logger.info(
                "[메일 미설정 - 발송 생략] to=%s subject=%s", mail.to, mail.subject
            )
        return

    # DNS 조회는 블로킹이므로 워커 스레드에서 합니다.
    pending = await asyncio.to_thread(_filter_undeliverable, pending)
    if not pending:
        return

    workers = min(MAIL_MAX_CONNECTIONS, len(pending))
    # 라운드로빈으로 나눠 각 연결이 비슷한 양을 맡게 합니다.
    batches = [pending[i::workers] for i in range(workers)]

    results = await asyncio.gather(
        *(asyncio.to_thread(_deliver_batch, batch) for batch in batches),
        return_exceptions=True,
    )

    for result in results:
        if isinstance(result, BaseException):
            logger.error("메일 배치 발송 실패", exc_info=result)
            continue
        for to, exc in result:
            logger.warning("메일 발송 실패 to=%s: %s", to, exc)


# asyncio는 실행 중인 태스크를 약한 참조로만 잡으므로, 붙잡아 두지 않으면
# 발송 도중에 수거될 수 있습니다 (calendar_service._spawn_background와 동일).
_background_tasks: set[asyncio.Task] = set()


def send_many_detached(mails: Sequence[Mail]) -> int:
    """발송을 백그라운드로 넘기고 바로 돌아옵니다. 넘긴 통수를 반환합니다.

    확정처럼 수십 명에게 메일이 나가는 작업에서, 사용자가 발송이 끝날 때까지
    기다릴 이유가 없습니다. Commeet의 DB가 이미 진실이고 메일은 안내일 뿐이라
    (calendar_service의 캘린더 동기화와 같은 이유) 요청과 분리해 보냅니다.
    호출자는 "이 페이지를 나가도 계속 전송됩니다"라고 안내해야 합니다.
    """
    # 예약 도메인은 여기서 바로 빼야 화면에 표시하는 통수가 실제와 맞습니다.
    # (DNS 확인은 send_many 안에서 스레드로 하므로 여기서는 하지 않습니다.)
    pending = _filter_reserved([m for m in mails if m.to])
    if not pending:
        return 0

    async def runner():
        try:
            await send_many(pending)
        except Exception:
            logger.exception("백그라운드 메일 발송 실패")

    task = asyncio.create_task(runner())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return len(pending)


async def _send(to: str, title: str, text: str, sender_name: str | None = None) -> None:
    """한 통 보내기. 여러 명이면 send_many()로 묶어 보내세요."""
    await send_many([Mail(to, title, text, sender_name or APP_NAME)])


def _owner_name(owner: dict | None) -> str:
    if not owner:
        return "누군가"
    return owner.get("name") or "누군가"


def _event_url(event: dict) -> str:
    return f"{BASE_URL}/e/{event.get('shortId') or event['_id']}"


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


async def send_password_reset_email(to: str, code: str) -> None:
    if not MAIL_ENABLED:
        # 메일이 안 붙는 로컬 개발에서는 코드가 갈 곳이 없으므로 콘솔로.
        logger.warning("[메일 미설정] %s 비밀번호 재설정 코드: %s", to, code)

    await _send(
        to,
        f"[{APP_NAME}] 비밀번호 재설정 코드",
        f"{APP_NAME} 비밀번호 재설정 코드입니다: {code}\n\n"
        f"이 코드는 {OTP_TTL_MINUTES}분 후에 만료됩니다.\n"
        f"본인이 요청하지 않았다면 이 메일은 무시하셔도 됩니다 - "
        f"비밀번호는 바뀌지 않습니다.\n",
    )


def _host_sender_name(owner: dict | None) -> str:
    """Invites come *from the host*, so their name leads the From header."""
    return f"{_owner_name(owner)} ({APP_NAME})"


# 아래 build_*_mail()들은 Mail만 만들고 보내지는 않습니다. 여러 명에게 갈 때
# 호출부가 목록으로 모아 send_many()에 한 번에 넘기기 위해서입니다.
# 한 명뿐이면 바로 아래의 send_*_email() 편의 함수를 쓰면 됩니다.


def _host_cc(
    owner: dict | None,
    to: str,
    cc: tuple[str, ...] = (),
    extra_to: tuple[str, ...] = (),
) -> tuple[str, ...]:
    """주최자를 참조(Cc)에 넣습니다.

    초대·안내·확정 등 일정에서 나가는 모든 메일의 사본이 주최자 편지함에도
    남게 합니다 - 무엇이 언제 나갔는지 주최자가 앱에 들어오지 않고도 알 수
    있습니다. 주최자 자신에게 가는 메일이거나 이미 수신자에 있으면 그대로
    둡니다."""
    email = ((owner or {}).get("email") or "").strip()
    seen = {addr.lower() for addr in (to, *cc, *extra_to) if addr}
    if not email or email.lower() in seen:
        return cc
    return (*cc, email)


def build_event_invite_mail(
    to: str, owner: dict | None, event: dict, message: str = ""
) -> Mail:
    host = _owner_name(owner)
    body = f"{host}님이 회원님을 일정 '{event['name']}'에 초대했습니다.\n\n"
    if message:
        body += f"{host}님의 메시지:\n{message}\n\n"
    body += f"아래 링크에서 가능한 시간을 표시해 주세요.\n{_event_url(event)}\n"
    return Mail(
        to=to,
        subject=f"[{APP_NAME}] {host}님이 '{event['name']}' 일정에 초대했습니다",
        body=body,
        sender_name=_host_sender_name(owner),
        cc=_host_cc(owner, to),
    )


def build_event_message_mail(
    to: str,
    host: dict | None,
    event: dict,
    message: str,
    *,
    subject: str = "",
    extra_to: tuple[str, ...] = (),
    cc: tuple[str, ...] = (),
) -> Mail:
    """주최자가 참가자에게 직접 쓴 짧은 안내. 응답 재촉이 주 용도입니다.

    초대 메일과 달리 "초대합니다"라고 하지 않습니다 - 이미 링크를 받은
    사람에게 다시 초대라고 하면 무엇이 달라진 건지 알 수 없습니다.
    """
    host_name = _owner_name(host)
    body = f"{host_name}님이 '{event['name']}' 일정에 대해 알려드립니다.\n\n"
    if message:
        body += f"{message}\n\n"
    body += f"아래 링크에서 가능한 시간을 확인하거나 수정할 수 있습니다.\n{_event_url(event)}\n"
    return Mail(
        to=to,
        # 주최자가 제목을 적으면 그대로, 비우면 기본 제목.
        subject=subject.strip() or f"[{APP_NAME}] '{event['name']}' 안내",
        body=body,
        sender_name=_host_sender_name(host),
        extra_to=extra_to,
        cc=_host_cc(host, to, cc, extra_to),
    )


async def send_event_invite_email(
    to: str, owner: dict | None, event: dict, message: str = ""
) -> None:
    await send_many([build_event_invite_mail(to, owner, event, message)])


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


def _format_meeting_time(
    start: datetime, end: datetime | None = None, *, with_tz: bool = False
) -> str:
    """Renders a meeting slot in the host's local wall time.

    `with_tz`는 시간대 이름(Asia/Seoul)을 덧붙입니다 - 해외 수신자가 본문의
    시각을 자기 시간대로 오해하지 않도록, 대표 시각(■ 일시) 한 줄에만
    붙입니다. 명단의 모든 줄마다 반복하면 소음이라 거기서는 뺍니다."""
    local_start = start.astimezone(MEETING_TZ)
    weekday = "월화수목금토일"[local_start.weekday()]
    text = f"{local_start.year}년 {local_start.month}월 {local_start.day}일({weekday}) {local_start:%H:%M}"
    if end is not None:
        text += f" ~ {end.astimezone(MEETING_TZ):%H:%M}"
    if with_tz:
        text += f" ({MEETING_TZ.key})"
    return text


def build_meeting_confirmed_mail(
    to: str,
    host: dict | None,
    event: dict,
    start: datetime,
    end: datetime,
    other_names: list[str],
    *,
    updated: bool = False,
    roster: list[tuple[datetime, datetime, list[str]]] | None = None,
    ics: str | None = None,
) -> Mail:
    """확정 안내. `roster`를 주면 전체 참가자 명단을 함께 싣습니다.

    받는 사람 자신의 시간(■ 일시)과 같은 자리에 오는 사람(■ 함께하는 분)만으로는
    "다른 사람들은 언제 오는지"를 알 수 없어, 서로 시간을 바꾸려 할 때마다
    주최자에게 물어봐야 했습니다. 명단은 시간 순으로 붙입니다.
    """
    host_name = _owner_name(host)
    headline = "일정이 변경되었습니다" if updated else "일정이 확정되었습니다"

    body = f"'{event['name']}' {headline}.\n\n"
    body += f"■ 일시: {_format_meeting_time(start, end, with_tz=True)}\n"
    if other_names:
        body += f"■ 함께하는 분: {', '.join(other_names)}\n"
    body += f"■ 주최: {host_name}님\n"

    if roster:
        total = sum(len(names) for _, _, names in roster)
        body += f"\n■ 전체 참가자 ({total}명)\n"
        for slot_start, slot_end, names in roster:
            body += f"  - {_format_meeting_time(slot_start, slot_end)} : {', '.join(names)}\n"

    body += (
        f"\n자세한 내용은 아래 링크에서 확인하실 수 있습니다.\n{_event_url(event)}\n"
    )

    return Mail(
        to=to,
        subject=f"[{APP_NAME}] '{event['name']}' {headline}",
        body=body,
        sender_name=_host_sender_name(host),
        cc=_host_cc(host, to),
        ics=ics,
    )


def build_meeting_unassigned_mail(
    to: str, host: dict | None, event: dict, *, ics: str | None = None
) -> Mail:
    return Mail(
        to=to,
        subject=f"[{APP_NAME}] '{event['name']}' 일정 배정 안내",
        body=(
            f"'{event['name']}' 일정이 확정되었지만, 아쉽게도 회원님과 맞는 시간을 찾지 못했습니다.\n\n"
            f"주최자({_owner_name(host)}님)에게 문의해 주세요.\n{_event_url(event)}\n"
        ),
        sender_name=_host_sender_name(host),
        cc=_host_cc(host, to),
        ics=ics,
        # 예전 배정을 캘린더에서 지우는 취소장입니다.
        ics_method="CANCEL",
    )


def build_meeting_cancelled_mail(
    to: str, host: dict | None, event: dict, start: datetime
) -> Mail:
    return Mail(
        to=to,
        subject=f"[{APP_NAME}] '{event['name']}' 일정 확정이 취소되었습니다",
        body=(
            f"'{event['name']}' 일정 확정이 취소되었습니다.\n\n"
            f"■ 취소된 일시: {_format_meeting_time(start, with_tz=True)}\n\n"
            f"다시 확정되면 새로 안내드리겠습니다.\n{_event_url(event)}\n"
        ),
        sender_name=_host_sender_name(host),
        cc=_host_cc(host, to),
    )


def build_event_cancelled_mail(
    to: str, owner: dict | None, event: dict, *, word: str = "취소"
) -> Mail:
    """일정 자체가 없어졌을 때.

    `word`는 "취소"(앞으로 있을 일정) 또는 "삭제"(이미 지난 일정)입니다 -
    지난 일정을 두고 "취소되었습니다"라고 하면 오지 않아도 될 사람이 놀랍니다.

    확정만 푸는 build_meeting_cancelled_mail과 달리 링크를 넣지 않습니다.
    지워진 일정의 링크는 "취소되었습니다" 안내만 띄우므로 굳이 보낼 이유가
    없습니다.
    """
    host = _owner_name(owner)
    if word == "삭제":
        body = (
            f"{host}님이 지난 일정 '{event['name']}'을(를) 삭제했습니다.\n\n"
            f"이미 지난 일정이라 참석에는 영향이 없으며, 입력하셨던 가능한 시간도 함께 정리됩니다.\n\n"
            f"문의는 {host}님에게 부탁드립니다.\n"
        )
    else:
        body = (
            f"{host}님이 '{event['name']}' 일정을 취소했습니다.\n\n"
            f"이 일정은 더 이상 진행되지 않으며, 입력하신 가능한 시간도 함께 정리됩니다.\n"
            f"확정된 약속이 있었다면 그 약속도 취소된 것으로 봐 주세요.\n\n"
            f"문의는 {host}님에게 부탁드립니다.\n"
        )
    return Mail(
        to=to,
        subject=f"[{APP_NAME}] '{event['name']}' 일정이 {word}되었습니다",
        body=body,
        sender_name=_host_sender_name(owner),
        cc=_host_cc(owner, to),
    )


def build_event_reopened_mail(to: str, owner: dict | None, event: dict) -> Mail:
    """취소했던 일정을 다시 되살렸을 때. 앞서 취소 안내를 받은 사람에게는
    그 안내를 정정해 줘야 합니다."""
    host = _owner_name(owner)
    return Mail(
        to=to,
        subject=f"[{APP_NAME}] '{event['name']}' 일정이 다시 열렸습니다",
        body=(
            f"취소되었던 '{event['name']}' 일정을 {host}님이 다시 열었습니다.\n\n"
            f"앞서 받으신 취소 안내는 무시해 주세요. 입력하신 가능한 시간은 그대로 남아 있습니다.\n\n"
            f"아래 링크에서 확인하실 수 있습니다.\n{_event_url(event)}\n"
        ),
        sender_name=_host_sender_name(owner),
        cc=_host_cc(owner, to),
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
