from fastapi import APIRouter, HTTPException, Response, status

from app.config import ALLOWED_EMAIL_DOMAIN, OTP_TTL_MINUTES
from app.schemas.auth import LoginRequest, SignupStartRequest, SignupVerifyRequest
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


@router.post("/login")
async def login(payload: LoginRequest, response: Response):
    user = await auth_service.authenticate(payload.email, payload.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="이메일 또는 비밀번호가 올바르지 않습니다",
        )

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
