from pydantic import BaseModel, EmailStr, Field


class SignupStartRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    name: str = Field(min_length=1)


class SignupVerifyRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6)


class LoginRequest(BaseModel):
    # 가입(SignupStartRequest)과 달리 EmailStr이 아니라 평범한 str입니다.
    # 형식이 틀린 값을 422로 되돌려주면 화면에는 pydantic의 검증 오류 배열이
    # 그대로 떠서 "무엇을 고쳐야 하는지" 알 수 없었습니다. 로그인에서 할 일은
    # 형식 검사가 아니라 조회이므로, 없는 이메일은 그냥 없는 이메일로 다룹니다.
    email: str
    password: str
