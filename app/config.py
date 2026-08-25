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

# MongoDB
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "pcts")

# Google Calendar integration (optional - only used for the "connect Google
# Calendar" feature in Settings, not for login, which is email+password).
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv(
    "GOOGLE_REDIRECT_URI", f"{BASE_URL}/calendar/google/callback"
)
GOOGLE_CALENDAR_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)

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

if MAIL_BACKEND == "postech":
    # The relay authorises by IP, so an address is all it takes to send.
    MAIL_SENDER = MAIL_SENDER or "pcts@postech.ac.kr"
    MAIL_ENABLED = True
else:
    MAIL_ENABLED = bool(MAIL_SENDER and MAIL_PASSWORD)
