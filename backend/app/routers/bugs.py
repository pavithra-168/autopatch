from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.database.session import get_db
from app.models.models import Bug, Project, User

router = APIRouter()


@router.get("/{bug_id}")
def get_bug(bug_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    bug = (
        db.query(Bug)
        .join(Project, Bug.project_id == Project.id)
        .filter(Bug.id == bug_id, Project.user_id == current_user.id)
        .first()
    )
    if not bug:
        raise HTTPException(status_code=404, detail="Bug not found")
    return {"bug": bug}
