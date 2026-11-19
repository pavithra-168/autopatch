from datetime import datetime
from pydantic import BaseModel, EmailStr, Field


class UserRegister(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=6)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: int
    full_name: str
    email: EmailStr
    preferred_language: str
    created_at: datetime

    class Config:
        from_attributes = True


class GitHubImportRequest(BaseModel):
    repository_url: str
    branch: str = "main"
    project_name: str = ""
    description: str = ""
    programming_language: str = "Python"


class RootCauseSchema(BaseModel):
    bug_description: str
    root_cause: str
    triggering_condition: str
    expected_behavior: str
    actual_behavior: str
    suggested_solution: str
    confidence_score: float = Field(ge=0.0, le=1.0)
