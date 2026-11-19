from datetime import datetime
import difflib
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.database.session import get_db
from app.models.models import Bug, ChangeHistory, Patch, Project, User

router = APIRouter()


@router.post("/{patch_id}/approve")
def approve_patch(patch_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    patch = (
        db.query(Patch)
        .join(Bug, Patch.bug_id == Bug.id)
        .join(Project, Bug.project_id == Project.id)
        .filter(Patch.id == patch_id, Project.user_id == current_user.id)
        .first()
    )
    if not patch:
        raise HTTPException(status_code=404, detail="Patch not found")
    patch.patch_status = "Approved"
    patch.reviewed_at = datetime.utcnow()
    patch.reviewed_by = current_user.id
    db.commit()
    return {"patch": patch}


@router.post("/{patch_id}/apply")
def apply_patch(patch_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = (
        db.query(Patch, Bug, Project)
        .join(Bug, Patch.bug_id == Bug.id)
        .join(Project, Bug.project_id == Project.id)
        .filter(Patch.id == patch_id, Project.user_id == current_user.id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Patch not found")
    patch, bug, project = row
    target = (Path(project.storage_path) / bug.file_path).resolve()
    if not str(target).startswith(str(Path(project.storage_path).resolve())):
        raise HTTPException(status_code=400, detail="Invalid file path")

    target.write_text(patch.proposed_code, encoding="utf-8")
    patch.patch_status = "Applied"
    db.add(
        ChangeHistory(
            project_id=project.id,
            bug_id=bug.id,
            patch_id=patch.id,
            user_id=current_user.id,
            action_type="PATCH_APPLIED",
            description=f"Applied patch #{patch.id} to {bug.file_path}",
        )
    )
    db.commit()
    return {"patch": patch, "diff": "\n".join(difflib.unified_diff(patch.original_code.splitlines(), patch.proposed_code.splitlines()))}
