from pydantic import BaseModel, EmailStr, Field


class ContactDetailsMixin(BaseModel):
    # Optional roster details (e.g. pasted from a department's advisee
    # management system) - a contact may have none, some, or all of these.
    relation: str | None = None  # 구분: 지도학생 / 공동지도학생
    degree: str | None = None  # 과정: 박사 / 석사 / 통합 / 학사
    gradSchool: str | None = None  # 대학원
    department: str | None = None  # 학과
    year: str | None = None  # 학년
    semester: str | None = None  # 학기
    studentId: str | None = None  # 학번
    status: str | None = None  # 학적상태
    phone: str | None = None
    memo: str | None = None  # free-form note about this person


class AddContactRequest(ContactDetailsMixin):
    email: EmailStr
    name: str = ""


class UpdateContactRequest(ContactDetailsMixin):
    name: str = Field(min_length=1)
    email: EmailStr
