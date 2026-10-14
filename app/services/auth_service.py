from datetime import UTC, datetime, timedelta

from bson import ObjectId
from fastapi import HTTPException, Request, Response, status

from app.config import (
    ALLOWED_EMAIL_DOMAIN,
    COOKIE_SECURE,
    OTP_MAX_TRIES,
    OTP_TTL_MINUTES,
    RESTRICT_SIGNUP_DOMAIN,
    SESSION_COOKIE_NAME,
    SESSION_MAX_AGE,
)
from app.core.security import (
    create_session_token,
    generate_otp_code,
    hash_otp_code,
    hash_password,
    read_session_token,
    verify_otp_code,
    verify_password,
)
from app.db import password_resets_col, pending_signups_col, users_col


class EmailDomainNotAllowed(Exception):
    pass


class EmailAlreadyRegistered(Exception):
    pass


class VerificationExpired(Exception):
    pass


class VerificationTooManyAttempts(Exception):
    pass


class VerificationCodeInvalid(Exception):
    pass


class EmailNotFound(Exception):
    """그 이메일로 가입된 계정이 없습니다."""


class PasswordMismatch(Exception):
    """계정은 있지만 비밀번호가 다릅니다."""


def normalize_email(email: str) -> str:
    return email.strip().lower()


def is_allowed_email(email: str) -> bool:
    """Whether this address may register. With RESTRICT_SIGNUP_DOMAIN off,
    any address can - OTP email verification still applies either way."""
    if not RESTRICT_SIGNUP_DOMAIN:
        return True
    return normalize_email(email).endswith(f"@{ALLOWED_EMAIL_DOMAIN}")


def default_calendar_options() -> dict:
    return {
        "bufferTime": {"enabled": False, "time": 15},
        "workingHours": {"enabled": False, "startTime": 9, "endTime": 17},
    }


async def get_user_by_email(email: str) -> dict | None:
    return await users_col.find_one({"email": normalize_email(email)})


async def get_user_by_id(user_id) -> dict | None:
    if not user_id:
        return None
    oid = (
        user_id
        if isinstance(user_id, ObjectId)
        else (ObjectId(user_id) if ObjectId.is_valid(str(user_id)) else None)
    )
    if oid is None:
        return None
    return await users_col.find_one({"_id": oid})


# ---------------------------------------------------------------------------
# Sign-up: email verification then account creation
# ---------------------------------------------------------------------------


async def start_signup(
    email: str, password: str, name: str, professor_features: bool = False
) -> str:
    """Stores a pending sign-up and returns the code to email to the user.

    The account is not created until the code is verified. Only the code's
    salted hash is stored, never the code itself.
    """
    email = normalize_email(email)
    if not is_allowed_email(email):
        raise EmailDomainNotAllowed()
    if await get_user_by_email(email):
        raise EmailAlreadyRegistered()

    code = generate_otp_code()
    now = datetime.now(UTC)
    await pending_signups_col.update_one(
        {"email": email},
        {
            "$set": {
                "email": email,
                "name": name.strip(),
                "passwordHash": hash_password(password),
                "professorFeatures": bool(professor_features),
                "codeHash": hash_otp_code(email, code),
                "expiresAt": now + timedelta(minutes=OTP_TTL_MINUTES),
                "tries": 0,
                "createdAt": now,
            }
        },
        upsert=True,
    )
    return code


async def verify_signup(email: str, code: str) -> dict:
    """Checks the emailed code and, on success, creates the account."""
    email = normalize_email(email)
    now = datetime.now(UTC)

    pending = await pending_signups_col.find_one(
        {"email": email, "expiresAt": {"$gt": now}}
    )
    if not pending:
        raise VerificationExpired()

    if int(pending.get("tries", 0)) >= OTP_MAX_TRIES:
        await pending_signups_col.delete_one({"email": email})
        raise VerificationTooManyAttempts()

    if not verify_otp_code(email, (code or "").strip(), pending.get("codeHash", "")):
        await pending_signups_col.update_one({"email": email}, {"$inc": {"tries": 1}})
        raise VerificationCodeInvalid()

    await pending_signups_col.delete_one({"email": email})

    if await get_user_by_email(email):
        raise EmailAlreadyRegistered()

    doc = {
        "email": email,
        "passwordHash": pending["passwordHash"],
        "name": pending.get("name", ""),
        "picture": "",
        "calendarAccounts": {},
        "calendarOptions": default_calendar_options(),
        "numEventsCreated": 0,
        "professorFeatures": bool(pending.get("professorFeatures")),
        "createdAt": now,
    }
    result = await users_col.insert_one(doc)
    doc["_id"] = result.inserted_id
    return doc


async def start_password_reset(email: str) -> str:
    """재설정 코드를 만들어 저장하고 돌려줍니다 (메일 발송은 호출부 몫).

    가입 인증(start_signup)과 같은 방식입니다 - 코드의 해시만 저장하고,
    문서는 TTL로 스스로 만료됩니다. 계정이 없으면 EmailNotFound를 던지는데,
    로그인 오류가 이미 "아이디가 일치하지 않습니다"라고 구분해 주고 있어
    (authenticate) 여기서 숨겨 봐야 얻는 것이 없기 때문입니다.
    """
    email = normalize_email(email)
    if not await get_user_by_email(email):
        raise EmailNotFound()

    code = generate_otp_code()
    now = datetime.now(UTC)
    await password_resets_col.update_one(
        {"email": email},
        {
            "$set": {
                "email": email,
                "codeHash": hash_otp_code(email, code),
                "expiresAt": now + timedelta(minutes=OTP_TTL_MINUTES),
                "tries": 0,
                "createdAt": now,
            }
        },
        upsert=True,
    )
    return code


async def verify_password_reset(email: str, code: str, new_password: str) -> dict:
    """코드가 맞으면 비밀번호를 바꾸고 사용자를 돌려줍니다.

    만료·시도 횟수 규칙은 가입 인증(verify_signup)과 동일합니다.
    """
    email = normalize_email(email)
    now = datetime.now(UTC)

    pending = await password_resets_col.find_one(
        {"email": email, "expiresAt": {"$gt": now}}
    )
    if not pending:
        raise VerificationExpired()
    if int(pending.get("tries", 0)) >= OTP_MAX_TRIES:
        raise VerificationTooManyAttempts()

    if not verify_otp_code(email, (code or "").strip(), pending.get("codeHash", "")):
        await password_resets_col.update_one({"email": email}, {"$inc": {"tries": 1}})
        raise VerificationCodeInvalid()

    await password_resets_col.delete_one({"email": email})

    user = await get_user_by_email(email)
    if not user:
        raise EmailNotFound()  # 코드를 받은 사이에 계정이 지워진 경우
    await users_col.update_one(
        {"_id": user["_id"]}, {"$set": {"passwordHash": hash_password(new_password)}}
    )
    return user


# ---------------------------------------------------------------------------
# Sign-in / password
# ---------------------------------------------------------------------------# ---------------------------------------------------------------------------
# Sign-in / password
# ---------------------------------------------------------------------------


async def authenticate(email: str, password: str) -> dict:
    """로그인. 실패하면 **어느 쪽이 틀렸는지** 구분해서 예외를 던집니다.

    가입 여부를 숨기는 쪽이 계정 존재 여부 탐색(enumeration)을 막는다는 점에서
    더 안전하지만, 이 서비스는 가입이 학교 도메인으로 제한된 내부 도구이고,
    "이메일과 비밀번호 중 하나가 틀렸습니다"는 고칠 곳을 알려 주지 못해
    실제로 로그인 실패를 반복하게 만들었습니다. 구분해서 알려 주기로 한
    선택입니다 - 되돌리려면 두 예외를 같은 메시지로 처리하면 됩니다.
    """
    user = await get_user_by_email(email)
    if not user:
        raise EmailNotFound()
    if not verify_password(password, user.get("passwordHash", "")):
        raise PasswordMismatch()
    return user


async def change_password(user: dict, current_password: str, new_password: str) -> None:
    if not verify_password(current_password, user.get("passwordHash", "")):
        raise ValueError("현재 비밀번호가 올바르지 않습니다")
    await users_col.update_one(
        {"_id": user["_id"]}, {"$set": {"passwordHash": hash_password(new_password)}}
    )


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------


def set_session_cookie(response: Response, user_id) -> None:
    response.set_cookie(
        SESSION_COOKIE_NAME,
        create_session_token(str(user_id)),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE_NAME)


async def get_optional_user(request: Request) -> dict | None:
    user_id = read_session_token(request.cookies.get(SESSION_COOKIE_NAME))
    if not user_id:
        return None
    return await get_user_by_id(user_id)


async def require_user(request: Request) -> dict:
    user = await get_optional_user(request)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not signed in"
        )
    return user


async def require_admin(request: Request) -> dict:
    user = await require_user(request)
    if not user.get("isAdmin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admins only")
    return user


def public_profile(user: dict | None) -> dict | None:
    if not user:
        return None
    return {
        "_id": str(user["_id"]),
        "name": user.get("name", ""),
        "picture": user.get("picture", ""),
    }
