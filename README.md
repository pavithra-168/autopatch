# AutoPatch — Autonomous Software Bug Detection & Repair System

AutoPatch is a full-stack debugging and automated code repair platform covering the complete workflow:

**Register → Login → Upload Project → Scan Project → Detect Bugs → Root-Cause Analysis → Generate Patch → Compare Code → Approve Patch → Run Sandboxed Tests → Validate Repair → Generate Report**

## Runtime Architecture

1. **Integrated Full-Stack App (Port 3000 — `server.ts` + Vite React SPA)**
   - Serves all 14 React pages with JWT authentication (`bcryptjs` + `jsonwebtoken`), rate limiting, ZIP extraction (`adm-zip` with path traversal protection), public GitHub cloning (`git clone --depth 1`), real Python 3.11 AST & security scanning (`server/python_ast_scanner.py`), Gemini AI root-cause diagnosis & patch generation (`@google/genai` `gemini-4-hydrogen`), side-by-side diff comparison (`diff`), immutable file backups & rollback, sandboxed `unittest` & edge-case execution (`server/python_test_runner.py`), and SQLite relational persistence (`storage/autopatch.db`).
2. **Python FastAPI + PostgreSQL + Celery + Docker Stack (`/backend` + `docker-compose.yml`)**
   - Production-oriented FastAPI backend with SQLAlchemy ORM models, Alembic migrations, Ruff + Bandit + Pytest static analyzers, Celery/Redis background workers, and PostgreSQL (`autopatch_db`).

## Local Setup in VS Code

### Option A: Run the Integrated Full-Stack Server (Node.js + Python 3.11)

1. Install Node.js 22+ and Python 3.11+ (`git` required for GitHub repository cloning).
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure `.env` from `.env.example` and set `GEMINI_API_KEY`.
4. Start the development server on port `3000`:
   ```bash
   npm run dev
   ```

### Option B: Run the Python FastAPI + PostgreSQL + Celery Stack

1. Ensure Python 3.11+, PostgreSQL 16, and Redis 7 are installed (or use Docker Compose).
2. Create and activate a virtual environment:
   ```bash
   cd backend
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. Create PostgreSQL database `autopatch_db` and copy `backend/.env.example` to `backend/.env`.
4. Run Alembic migrations:
   ```bash
   alembic revision --autogenerate -m "initial"
   alembic upgrade head
   ```
5. Start FastAPI (Swagger UI at `http://localhost:8000/docs`) and Celery worker:
   ```bash
   uvicorn app.main:app --reload --port 8000
   celery -A app.workers.celery_app worker --loglevel=info
   ```
6. Run backend tests:
   ```bash
   pytest
   ```

### Option C: Docker Compose

```bash
docker compose up --build
```
