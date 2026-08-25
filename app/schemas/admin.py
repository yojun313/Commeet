from pydantic import BaseModel, EmailStr


class SetAdminRequest(BaseModel):
    isAdmin: bool


class TestMailRequest(BaseModel):
    to: EmailStr
