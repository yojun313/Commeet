import os

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).lower() == "true"


# General
APP_NAME = "PCTS"
APP_FULL_NAME = "POSTECH CSE Time Scheduler"
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")
ENV = os.getenv("ENV", "development")
SUPPORT_EMAIL = os.getenv("SUPPORT_EMAIL", "yojun313@postech.ac.kr")

# Session / auth
SESSION_SECRET = os.getenv("SESSION_SECRET", "dev-insecure-secret-change-me")
SESSION_COOKIE_NAME = "pcts_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

# Sign-up is restricted to this email domain, verified by an emailed OTP code.
ALLOWED_EMAIL_DOMAIN = os.getenv("ALLOWED_EMAIL_DOMAIN", "postech.ac.kr")
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
    "GOOGLE_REDIRECT_URI", f"{BASE_URL}/api/calendar/google/callback"
)
GOOGLE_CALENDAR_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)

# Gmail sender (optional - emails are logged to console if not configured).
# MAIL_PASSWORD must be a Google "app password", not the account password.
MAIL_SENDER = os.getenv("MAIL_SENDER", "")
MAIL_PASSWORD = os.getenv("MAIL_PASSWORD", "")
MAIL_ENABLED = bool(MAIL_SENDER and MAIL_PASSWORD)
