from datetime import datetime
from celery import Celery

from app.analyzers.python_analyzer import run_ruff_and_bandit
from app.core.config import settings
from app.database.session import SessionLocal
from app.models.models import Bug, Project, ScanJob

celery_app = Celery("autopatch_worker", broker=settings.REDIS_URL, backend=settings.REDIS_URL)


@celery_app.task(name="autopatch.run_scan")
def run_scan_task(scan_id: int):
    db = SessionLocal()
    try:
        scan = db.query(ScanJob).filter(ScanJob.id == scan_id).first()
        if not scan:
            return
        project = db.query(Project).filter(Project.id == scan.project_id).first()
        scan.scan_status = "Running"
        scan.progress_percentage = 35
        db.commit()

        results = run_ruff_and_bandit(project.storage_path)
        for item in results:
            db.add(
                Bug(
                    project_id=project.id,
                    scan_id=scan.id,
                    bug_title=f"[{item['tool']}] {item.get('code', 'ISSUE')}",
                    bug_description=item.get("message", ""),
                    bug_category=item["tool"].upper(),
                    severity=str(item.get("severity", "Medium")).title(),
                    file_path=item.get("filename", ""),
                    start_line=int(item.get("line", 1)),
                    end_line=int(item.get("line", 1)),
                )
            )
        scan.total_bugs = len(results)
        scan.progress_percentage = 100
        scan.scan_status = "Completed"
        scan.completed_at = datetime.utcnow()
        db.commit()
    except Exception as exc:
        if scan:
            scan.scan_status = "Failed"
            scan.error_message = str(exc)
            db.commit()
    finally:
        db.close()
