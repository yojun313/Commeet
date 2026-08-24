"""Password hashing and signed session-cookie helpers.

Sessions are stateless: the cookie holds a timestamp-signed payload
(itsdangerous), so there is no server-side session store to keep in sync
with MongoDB - the cookie itself is the source of truth for "who is this
request from", same as the `session` cookie in the original Go app but
signed client-side instead of stored server-side.
"""

import hashlib
import secrets

import bcrypt
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.config import SESSION_MAX_AGE, SESSION_SECRET

_serializer = URLSafeTimedSerializer(SESSION_SECRET, salt="pcts-session")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    if not password_hash:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def create_session_token(user_id: str) -> str:
    return _serializer.dumps({"userId": user_id})


def generate_otp_code() -> str:
    return f"{secrets.randbelow(1000000):06d}"


def hash_otp_code(email: str, code: str) -> str:
    """Codes are never stored in the clear - only this salted digest is."""
    raw = f"{email}|{code}|{SESSION_SECRET}".encode()
    return hashlib.sha256(raw).hexdigest()


def verify_otp_code(email: str, code: str, expected_hash: str) -> bool:
    return bool(expected_hash) and secrets.compare_digest(
        expected_hash, hash_otp_code(email, code)
    )


def read_session_token(token: str | None) -> str | None:
    if not token:
        return None
    try:
        data = _serializer.loads(token, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    return data.get("userId")
