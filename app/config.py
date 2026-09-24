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
# 운영(https) 배포에서는 쿠키에 Secure를 붙여 평문 HTTP로 새지 않게 합니다.
# 로컬 개발(http://localhost)은 BASE_URL이 http라 자동으로 꺼집니다.
COOKIE_SECURE = BASE_URL.startswith("https://")

# Sign-up is always verified by an emailed OTP code. When
# RESTRICT_SIGNUP_DOMAIN is on (the default), it is additionally limited to
# ALLOWED_EMAIL_DOMAIN; turn it off to let any email address register.
ALLOWED_EMAIL_DOMAIN = os.getenv("ALLOWED_EMAIL_DOMAIN", "postech.ac.kr")
# 포스텍 구성원 제한. 켜면 두 가지가 잠깁니다:
#   1) 가입: ALLOWED_EMAIL_DOMAIN 주소로만 (기존 동작)
#   2) 일정 생성: 교내 IP(141.223.*)이거나 그 도메인 계정으로 로그인한 경우만.
#      외부인은 초대받은 일정에 응답만 할 수 있습니다.
# 예전 이름(RESTRICT_SIGNUP_DOMAIN)도 계속 읽으므로 기존 .env는 그대로 동작합니다.
RESTRICT_TO_POSTECH = _bool(
    "RESTRICT_TO_POSTECH", os.getenv("RESTRICT_SIGNUP_DOMAIN", "true")
)
# 이전 이름을 쓰던 코드·템플릿을 위한 별칭.
RESTRICT_SIGNUP_DOMAIN = RESTRICT_TO_POSTECH

# 교내로 인정하는 IP 접두어 (pcss와 같은 기준).
POSTECH_IP_PREFIXES = ("141.223.",)
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

# 서버 밖(개발용 맥 등)에서 서버의 MongoDB를 쓰기 위한 SSH 터널. 켜면 앱이
# 뜰 때 SSH로 먼저 붙고, MONGO_URI의 호스트 자리를 그 터널의 로컬 포트로
# 바꿔서 접속합니다 - 즉 터널을 쓰든 안 쓰든 MONGO_URI는 "서버에서 본
# MongoDB 주소"로 똑같이 적으면 됩니다 (app/db/mongo.py).
# 서버 안에서 돌 때는 꺼 두세요. 자기 자신에게 SSH를 걸 이유가 없습니다.
MONGO_SSH_TUNNEL = _bool("MONGO_SSH_TUNNEL", "false")
SSH_HOST = os.getenv("SSH_HOST", "").strip()
SSH_PORT = int(os.getenv("SSH_PORT", "22"))
SSH_USER = os.getenv("SSH_USER", "").strip()
# 개인키 파일 경로(~ 표기 가능). 키 대신 비밀번호로 붙으려면 SSH_PASSWORD.
SSH_KEY = os.path.expanduser(os.getenv("SSH_KEY", "").strip())
SSH_KEY_PASSPHRASE = os.getenv("SSH_KEY_PASSPHRASE", "")
SSH_PASSWORD = os.getenv("SSH_PASSWORD", "")

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

# 명시적 차단 스위치. 테스트가 .env의 실제 자격증명을 물려받은 채 확정/초대
# 흐름을 돌리면 **진짜 메일이 나가서** 가짜 주소의 반송이 발신 계정에
# 쌓입니다 - 실제로 겪은 사고입니다. 백엔드/자격증명과 무관하게 끕니다.
if _bool("MAIL_ENABLED", "true") is False:
    MAIL_ENABLED = False
