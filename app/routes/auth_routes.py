from fastapi import APIRouter, HTTPException, Response, status

from app.config import ALLOWED_EMAIL_DOMAIN, OTP_TTL_MINUTES
from app.schemas.auth import (
    LoginRequest,
    PasswordResetStartRequest,
    PasswordResetVerifyRequest,
    SignupStartRequest,
    SignupVerifyRequest,
)
from app.services import auth_service, email_service

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/signup/send-code")
async def signup_send_code(payload: SignupStartRequest):
    """Step 1 of sign-up: email a verification code. No account yet."""
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
async def password_reset_send_code(payload: PasswordResetStartRequest):
    """1단계: 재설정 코드를 메일로 보냅니다. 비밀번호는 아직 그대로입니다."""
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
async def login(payload: LoginRequest, response: Response):
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
