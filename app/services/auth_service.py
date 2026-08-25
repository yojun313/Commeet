from datetime import UTC, datetime, timedelta

from bson import ObjectId
from fastapi import HTTPException, Request, Response, status

from app.config import (
    ALLOWED_EMAIL_DOMAIN,
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
from app.db import pending_signups_col, users_col


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


async def start_signup(email: str, password: str, name: str) -> str:
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
        "createdAt": now,
    }
    result = await users_col.insert_one(doc)
    doc["_id"] = result.inserted_id
    return doc


# ---------------------------------------------------------------------------
# Sign-in / password
# ---------------------------------------------------------------------------


async def authenticate(email: str, password: str) -> dict | None:
    user = await get_user_by_email(email)
    if not user or not verify_password(password, user.get("passwordHash", "")):
        return None
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
