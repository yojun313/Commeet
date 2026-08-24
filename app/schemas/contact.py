from pydantic import BaseModel, EmailStr, Field


class AddContactRequest(BaseModel):
    email: EmailStr
    name: str = ""


class UpdateContactRequest(BaseModel):
    name: str = Field(min_length=1)
