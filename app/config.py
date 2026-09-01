import os

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).lower() == "true"


# General
APP_NAME = "Commeet"
APP_FULL_NAME = "POSTECH CSE Time Scheduler"
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")
ENV = os.getenv("ENV", "development")
SUPPORT_EMAIL = os.getenv("SUPPORT_EMAIL", "yojun313@postech.ac.kr")
# Shown alongside SUPPORT_EMAIL in the footer credits.
PROFESSOR_EMAIL = os.getenv("PROFESSOR_EMAIL", "g.kim@postech.ac.kr")

# Session / auth
SESSION_SECRET = os.getenv("SESSION_SECRET", "dev-insecure-secret-change-me")
SESSION_COOKIE_NAME = "pcts_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

# Sign-up is always verified by an emailed OTP code. When
# RESTRICT_SIGNUP_DOMAIN is on (the default), it is additionally limited to
# ALLOWED_EMAIL_DOMAIN; turn it off to let any email address register.
ALLOWED_EMAIL_DOMAIN = os.getenv("ALLOWED_EMAIL_DOMAIN", "postech.ac.kr")
RESTRICT_SIGNUP_DOMAIN = _bool("RESTRICT_SIGNUP_DOMAIN", "true")
OTP_TTL_MINUTES = 10
OTP_MAX_TRIES = 5

# Meeting records (학생지도비 신청서). Attendee names, meeting notes, receipt
# and signature images are personal data, so they are encrypted at rest -
# see app/services/crypto_service.py. RECORD_STORAGE_DIR holds the encrypted
# blobs; when unset it defaults to a gitignored folder in the project root.
RECORD_STORAGE_DIR = os.getenv("RECORD_STORAGE_DIR", "").strip()
# Base64 Fernet key. Left blank, one is derived from SESSION_SECRET so the
# feature works with no extra setup - but then rotating SESSION_SECRET also
# makes existing records unreadable, so production should set this explicitly.
RECORD_ENCRYPTION_KEY = os.getenv("RECORD_ENCRYPTION_KEY", "").strip()

# 학생지도비 unit prices per attendee, by affiliation (원).
GUIDANCE_FEE_RATES = {
    "cse": int(os.getenv("GUIDANCE_FEE_CSE", "30000")),
    "muunjae": int(os.getenv("GUIDANCE_FEE_MUUNJAE", "15000")),
}

# MongoDB
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "commeet")

# Google Calendar integration (optional - only used for the "connect Google
# Calendar" feature in Settings, not for login, which is email+password).
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv(
    "GOOGLE_REDIRECT_URI", f"{BASE_URL}/calendar/google/callback"
)
# .env에서 GOOGLE_CALENDAR_ENABLED=false로 통째로 끌 수 있습니다. 끄면 연동
# 기능이 동작하지 않을 뿐 아니라 관련 UI가 화면에서 사라집니다 - 쓰지 않는
# 기능의 버튼과 안내가 남아 있으면 그것도 설명해야 할 대상이 됩니다.
# 자격증명이 없으면 켜 두어도 동작할 수 없으므로 자동으로 꺼집니다.
GOOGLE_CALENDAR_ENABLED = _bool("GOOGLE_CALENDAR_ENABLED", "true") and bool(
    GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
)

# Mail sending. MAIL_BACKEND picks how mail leaves this server:
#   gmail   - smtp.gmail.com:587, logging in with a Google "app password"
#             (MAIL_SENDER + MAIL_PASSWORD). Works from anywhere.
#   postech - smtp.postech.ac.kr:25 unauthenticated relay. Needs no credentials,
#             but only works from an IP registered with the POSTECH mail admin
#             ('이메일 무인증 발송신청'). Registered IP: 141.223.145.21.
#             Anywhere else the relay answers '421 4.3.2 Service not available'.
# Emails are logged to the console instead of sent when the chosen backend is
# not configured, so local development never has to special-case mail.
MAIL_BACKEND = os.getenv("MAIL_BACKEND", "gmail").strip().lower()

MAIL_SENDER = os.getenv("MAIL_SENDER", "")
MAIL_PASSWORD = os.getenv("MAIL_PASSWORD", "")

# postech backend only
POSTECH_SMTP_HOST = os.getenv("MAIL_SMTP_HOST", "smtp.postech.ac.kr")
POSTECH_SMTP_PORT = int(os.getenv("MAIL_SMTP_PORT", "25"))
MAIL_STARTTLS = _bool("MAIL_STARTTLS", "true")

MAIL_REPLY_TO = os.getenv("MAIL_REPLY_TO", "").strip()
MAIL_TIMEOUT = int(os.getenv("MAIL_TIMEOUT", "30"))

# 여러 명에게 한꺼번에 보낼 때 동시에 여는 SMTP 연결 수. 각 연결은 자기 몫을
# 이어서 보내므로, 34통이 34번의 접속+로그인이 아니라 4번으로 줄어듭니다.
# 무작정 늘리면 메일 서버가 동시 접속을 거절하거나 스팸으로 판단할 수 있어
# 기본값을 낮게 잡았습니다.
MAIL_MAX_CONNECTIONS = max(1, int(os.getenv("MAIL_MAX_CONNECTIONS", "4")))

# 보내기 전에 수신 도메인이 메일을 받을 수 있는지 DNS로 확인합니다. 없는
# 도메인에 계속 시도하면 로그가 지저분해질 뿐 아니라 발신 평판도 깎입니다.
# 판단이 서지 않을 때는 보내는 쪽(fail-open)이라, DNS가 잠깐 죽어도 진짜
# 메일이 조용히 사라지지는 않습니다.
MAIL_VERIFY_DOMAIN = _bool("MAIL_VERIFY_DOMAIN", "true")
MAIL_DNS_TIMEOUT = float(os.getenv("MAIL_DNS_TIMEOUT", "3"))

if MAIL_BACKEND == "postech":
    # The relay authorises by IP, so an address is all it takes to send.
    MAIL_SENDER = MAIL_SENDER or "commeet@postech.ac.kr"
    MAIL_ENABLED = True
else:
    MAIL_ENABLED = bool(MAIL_SENDER and MAIL_PASSWORD)
