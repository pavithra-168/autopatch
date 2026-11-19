from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.database.session import Base, engine
from app.routers import auth, bugs, patches, projects

Base.metadata.create_all(bind=engine)

app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description="AutoPatch Autonomous Software Bug Detection and Repair API",
    docs_url="/docs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.CORS_ORIGINS.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth", tags=["Authentication"])
app.include_router(projects.router, prefix="/api/projects", tags=["Projects"])
app.include_router(bugs.router, prefix="/api/bugs", tags=["Bugs"])
app.include_router(patches.router, prefix="/api/patches", tags=["Patches"])


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "autopatch-fastapi"}
