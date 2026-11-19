import os
import shutil
import zipfile
from pathlib import Path
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import get_current_user
from app.database.session import get_db
from app.models.models import Project, ScanJob, User
from app.schemas.schemas import GitHubImportRequest
from app.workers.celery_app import run_scan_task

router = APIRouter()


@router.post("/upload")
async def upload_project(
    file: UploadFile = File(...),
    project_name: str = Form(...),
    description: str = Form(""),
    programming_language: str = Form("Python"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Only .zip files are supported")

    base_dir = Path(settings.STORAGE_PATH).resolve()
    base_dir.mkdir(parents=True, exist_ok=True)
    target_dir = (base_dir / f"{current_user.id}_{project_name.replace(' ', '_')}").resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    zip_path = target_dir / "upload.zip"
    with zip_path.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.namelist():
            dest = (target_dir / member).resolve()
            if not str(dest).startswith(str(target_dir)):
                shutil.rmtree(target_dir, ignore_errors=True)
                raise HTTPException(status_code=400, detail="Unsafe ZIP path traversal blocked")
        zf.extractall(target_dir)
    zip_path.unlink(missing_ok=True)

    project = Project(
        user_id=current_user.id,
        project_name=project_name,
        description=description,
        programming_language=programming_language,
        source_type="zip",
        storage_path=str(target_dir),
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"project": project}


@router.post("/github")
def import_github(
    payload: GitHubImportRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not payload.repository_url.startswith("https://github.com/"):
        raise HTTPException(status_code=400, detail="Only HTTPS GitHub URLs are supported")
    project = Project(
        user_id=current_user.id,
        project_name=payload.project_name or os.path.basename(payload.repository_url),
        description=payload.description,
        programming_language=payload.programming_language,
        source_type="github",
        repository_url=payload.repository_url,
        default_branch=payload.branch,
        storage_path=str(Path(settings.STORAGE_PATH).resolve() / f"gh_{current_user.id}"),
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"project": project}


@router.get("")
def list_projects(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"projects": db.query(Project).filter(Project.user_id == current_user.id).all()}


@router.post("/{project_id}/scan")
def trigger_scan(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = db.query(Project).filter(Project.id == project_id, Project.user_id == current_user.id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    scan = ScanJob(project_id=project.id, scan_status="Pending")
    db.add(scan)
    db.commit()
    db.refresh(scan)
    run_scan_task.delay(scan.id)
    return {"scan": scan}
