import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STORAGE_ROOT = path.resolve(process.env.STORAGE_PATH || './storage');
fs.mkdirSync(STORAGE_ROOT, { recursive: true });
fs.mkdirSync(path.join(STORAGE_ROOT, 'uploaded_projects'), { recursive: true });
fs.mkdirSync(path.join(STORAGE_ROOT, 'backups'), { recursive: true });

export const STORAGE_DIR = STORAGE_ROOT;
export const PROJECTS_DIR = path.join(STORAGE_ROOT, 'uploaded_projects');
export const BACKUPS_DIR = path.join(STORAGE_ROOT, 'backups');

const DB_PATH = path.join(STORAGE_ROOT, 'autopatch.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    profile_image TEXT DEFAULT '/src/assets/images/avatar_developer_default_1795083113786.jpg',
    preferred_language TEXT DEFAULT 'Python',
    notify_scan_complete INTEGER DEFAULT 1,
    notify_critical_bugs INTEGER DEFAULT 1,
    notify_patch_tests INTEGER DEFAULT 1,
    theme_mode TEXT DEFAULT 'midnight',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    revoked INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    programming_language TEXT NOT NULL DEFAULT 'Python',
    source_type TEXT NOT NULL DEFAULT 'zip',
    repository_url TEXT DEFAULT '',
    default_branch TEXT DEFAULT 'main',
    commit_hash TEXT DEFAULT '',
    storage_path TEXT NOT NULL,
    project_status TEXT NOT NULL DEFAULT 'uploaded',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_extension TEXT DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    programming_language TEXT DEFAULT 'Unknown',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scan_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scan_status TEXT NOT NULL DEFAULT 'Pending',
    current_stage TEXT NOT NULL DEFAULT 'Project Structure Analysis',
    progress_percentage INTEGER NOT NULL DEFAULT 0,
    total_files INTEGER NOT NULL DEFAULT 0,
    scanned_files INTEGER NOT NULL DEFAULT 0,
    total_bugs INTEGER NOT NULL DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS bugs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bug_code TEXT NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scan_id INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    bug_title TEXT NOT NULL,
    bug_description TEXT NOT NULL,
    bug_category TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence_score REAL NOT NULL DEFAULT 0.85,
    analyzer_source TEXT NOT NULL DEFAULT 'Python AST',
    evidence TEXT DEFAULT '',
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL DEFAULT 1,
    end_line INTEGER NOT NULL DEFAULT 1,
    original_code TEXT NOT NULL DEFAULT '',
    root_cause TEXT DEFAULT '',
    why_it_occurs TEXT DEFAULT '',
    triggering_condition TEXT DEFAULT '',
    expected_behavior TEXT DEFAULT '',
    actual_behavior TEXT DEFAULT '',
    potential_impact TEXT DEFAULT '',
    suggested_solution TEXT DEFAULT '',
    bug_status TEXT NOT NULL DEFAULT 'Open',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS patches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    original_code TEXT NOT NULL,
    proposed_code TEXT NOT NULL,
    code_diff TEXT NOT NULL,
    explanation TEXT NOT NULL,
    repair_reason TEXT NOT NULL DEFAULT '',
    original_file_hash TEXT NOT NULL,
    patch_status TEXT NOT NULL DEFAULT 'Pending Approval',
    validation_status TEXT NOT NULL DEFAULT 'Validation Incomplete',
    backup_path TEXT DEFAULT '',
    generated_at TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS test_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patch_id INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    phase TEXT NOT NULL DEFAULT 'after',
    test_name TEXT NOT NULL,
    test_description TEXT NOT NULL,
    test_status TEXT NOT NULL,
    execution_time REAL NOT NULL DEFAULT 0,
    error_message TEXT DEFAULT '',
    output TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS change_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    bug_id INTEGER REFERENCES bugs(id) ON DELETE SET NULL,
    patch_id INTEGER REFERENCES patches(id) ON DELETE SET NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    previous_value TEXT DEFAULT '',
    new_value TEXT DEFAULT '',
    description TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    notification_type TEXT NOT NULL DEFAULT 'info',
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS repository_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'github',
    repository_name TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
  CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs(project_id);
  CREATE INDEX IF NOT EXISTS idx_bugs_scan ON bugs(scan_id);
  CREATE INDEX IF NOT EXISTS idx_patches_bug ON patches(bug_id);
  CREATE INDEX IF NOT EXISTS idx_history_project ON change_history(project_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
`);

export function createNotification(
  userId: number,
  title: string,
  message: string,
  notificationType: 'info' | 'success' | 'warning' | 'error' = 'info'
) {
  db.prepare(
    `INSERT INTO notifications (user_id, title, message, notification_type) VALUES (?, ?, ?, ?)`
  ).run(userId, title, message, notificationType);
}

export function recordHistory(params: {
  projectId: number;
  bugId?: number | null;
  patchId?: number | null;
  userId: number;
  actionType: string;
  previousValue?: string;
  newValue?: string;
  description: string;
}) {
  db.prepare(
    `INSERT INTO change_history (project_id, bug_id, patch_id, user_id, action_type, previous_value, new_value, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.projectId,
    params.bugId ?? null,
    params.patchId ?? null,
    params.userId,
    params.actionType,
    params.previousValue ?? '',
    params.newValue ?? '',
    params.description
  );
}
