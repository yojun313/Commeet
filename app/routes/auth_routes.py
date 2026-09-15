from fastapi import APIRouter, HTTPException, Request, Response, status

from app.config import ALLOWED_EMAIL_DOMAIN, OTP_TTL_MINUTES
from app.core import ratelimit
from app.core.clientip import get_client_ip
from app.schemas.auth import (
    LoginRequest,
    PasswordResetStartRequest,
    PasswordResetVerifyRequest,
    SignupStartRequest,
    SignupVerifyRequest,
)
from app.services import auth_service, email_service

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _limit(request: Request, bucket: str, email: str, *, limit: int, per_seconds: int):
    """IP 기준과 (IP, 이메일) 기준을 함께 겁니다.

    이메일 기준만 걸면 공격자가 이메일을 바꿔 가며 무한히 시도하고,
    IP 기준만 걸면 한 계정을 여러 IP에서 나눠 두드립니다. 이메일 축은
    IP와 묶어 세므로, 공유 IP(기숙사 NAT) 뒤의 다른 사용자를 한 명의
    실수로 잠그지 않습니다.
    """
    ip = get_client_ip(request) or "?"
    ok_ip = ratelimit.allow(f"{bucket}:{ip}", limit=limit * 4, per_seconds=per_seconds)
    ok_pair = ratelimit.allow(
        f"{bucket}:{ip}:{email.lower()}", limit=limit, per_seconds=per_seconds
    )
    if not (ok_ip and ok_pair):
        raise HTTPException(
            status_code=429,
            detail="시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        )


@router.post("/signup/send-code")
async def signup_send_code(payload: SignupStartRequest, request: Request):
    """Step 1 of sign-up: email a verification code. No account yet."""
    _limit(request, "send-code", payload.email, limit=3, per_seconds=600)
    try:
        code = await auth_service.start_signup(
            payload.email, payload.password, payload.name
        )
    except auth_service.EmailDomainNotAllowed as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{ALLOWED_EMAIL_DOMAIN} 이메일만 가입할 수 있습니다.",
        ) from exc
    except auth_service.EmailAlreadyRegistered as exc:
        raise HTTPException(
            status_code=400, detail="이미 가입된 이메일입니다."
        ) from exc

    await email_service.send_verification_code_email(payload.email, code)
    return {"email": payload.email, "expiresInMinutes": OTP_TTL_MINUTES}


@router.post("/signup/verify", status_code=status.HTTP_201_CREATED)
async def signup_verify(payload: SignupVerifyRequest, response: Response):
    """Step 2 of sign-up: check the code, then create the account."""
    try:
        user = await auth_service.verify_signup(payload.email, payload.code)
    except auth_service.VerificationExpired as exc:
        raise HTTPException(
            status_code=400, detail="코드가 만료되었거나 없습니다. 다시 요청해 주세요."
        ) from exc
    except auth_service.VerificationTooManyAttempts as exc:
        raise HTTPException(
            status_code=429,
            detail="시도 횟수를 초과했습니다. 코드를 다시 요청해 주세요.",
        ) from exc
    except auth_service.VerificationCodeInvalid as exc:
        raise HTTPException(
            status_code=400, detail="인증 코드가 올바르지 않습니다."
        ) from exc
    except auth_service.EmailAlreadyRegistered as exc:
        raise HTTPException(
            status_code=400, detail="이미 가입된 이메일입니다."
        ) from exc

    auth_service.set_session_cookie(response, user["_id"])
    return {"id": str(user["_id"]), "email": user["email"], "name": user["name"]}


@router.post("/password-reset/send-code")
async def password_reset_send_code(
    payload: PasswordResetStartRequest, request: Request
):
    """1단계: 재설정 코드를 메일로 보냅니다. 비밀번호는 아직 그대로입니다."""
    _limit(request, "send-code", payload.email, limit=3, per_seconds=600)
    try:
        code = await auth_service.start_password_reset(payload.email)
    except auth_service.EmailNotFound as exc:
        raise HTTPException(
            status_code=404, detail="가입되지 않은 이메일입니다."
        ) from exc

    await email_service.send_password_reset_email(payload.email, code)
    return {"email": payload.email, "expiresInMinutes": OTP_TTL_MINUTES}


@router.post("/password-reset/verify")
async def password_reset_verify(
    payload: PasswordResetVerifyRequest, response: Response
):
    """2단계: 코드가 맞으면 새 비밀번호로 바꾸고 바로 로그인시킵니다.

    방금 이메일 소유를 증명하고 새 비밀번호까지 정한 사람에게 다시 로그인
    화면을 거치게 할 이유가 없습니다.
    """
    try:
        user = await auth_service.verify_password_reset(
            payload.email, payload.code, payload.newPassword
        )
    except auth_service.VerificationExpired as exc:
        raise HTTPException(
            status_code=400, detail="코드가 만료되었거나 없습니다. 다시 요청해 주세요."
        ) from exc
    except auth_service.VerificationTooManyAttempts as exc:
        raise HTTPException(
            status_code=429,
            detail="시도 횟수를 초과했습니다. 코드를 다시 요청해 주세요.",
        ) from exc
    except auth_service.VerificationCodeInvalid as exc:
        raise HTTPException(
            status_code=400, detail="인증 코드가 올바르지 않습니다."
        ) from exc
    except auth_service.EmailNotFound as exc:
        raise HTTPException(
            status_code=404, detail="가입되지 않은 이메일입니다."
        ) from exc

    auth_service.set_session_cookie(response, user["_id"])
    return {
        "id": str(user["_id"]),
        "email": user["email"],
        "name": user.get("name", ""),
    }


@router.post("/login")
async def login(payload: LoginRequest, request: Request, response: Response):
    _limit(request, "login", payload.email, limit=8, per_seconds=300)
    try:
        user = await auth_service.authenticate(payload.email, payload.password)
    except auth_service.EmailNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="아이디가 일치하지 않습니다.",
        ) from exc
    except auth_service.PasswordMismatch as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="비밀번호가 일치하지 않습니다.",
        ) from exc

    auth_service.set_session_cookie(response, user["_id"])
    return {
        "id": str(user["_id"]),
        "email": user["email"],
        "name": user.get("name", ""),
    }


@router.post("/logout")
async def logout(response: Response):
    auth_service.clear_session_cookie(response)
    return {}
