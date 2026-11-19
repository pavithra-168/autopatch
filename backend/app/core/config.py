from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "AutoPatch API"
    DATABASE_URL: str = "postgresql+psycopg://autopatch:autopatch@localhost:5432/autopatch_db"
    SECRET_KEY: str = "dev-secret-change-me"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REDIS_URL: str = "redis://localhost:6379/0"
    AI_PROVIDER_API_KEY: str = ""
    GITHUB_CLIENT_ID: str = ""
    GITHUB_CLIENT_SECRET: str = ""
    GITHUB_CALLBACK_URL: str = "http://localhost:8000/api/auth/github/callback"
    STORAGE_PATH: str = "../storage/uploaded_projects"
    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:5173"

    class Config:
        env_file = ".env"


settings = Settings()
