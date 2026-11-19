import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { createPatch } from 'diff';
import express from 'express';
import multer from 'multer';
import {
  authRateLimiter,
  createRefreshToken,
  generateAccessToken,
  hashPassword,
  requireAuth,
  revokeRefreshToken,
  verifyAccessToken,
  verifyPassword,
  verifyRefreshToken,
  type AuthRequest,
} from './auth.ts';
import {
  collectProjectFiles,
  isTargetBugResolvedInFile,
  runSandboxedJsTsTests,
  runSandboxedPythonTests,
  sha256File,
  startProjectScanJob,
  validateProposedPatchContent,
  writeSampleBuggyPythonProject,
} from './analyzer.ts';
import {
  BACKUPS_DIR,
  PROJECTS_DIR,
  createNotification,
  db,
  recordHistory,
} from './db.ts';
import { emitUserUpdate, subscribeUserUpdates } from './events.ts';
import { analyzeBugRootCauseWithAI, generatePatchWithAI } from './gemini.ts';

const execFileAsync = promisify(execFile);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export const apiRouter = express.Router();

// ---------------------------------------------------------------------------
// 1. AUTHENTICATION ROUTES
// ---------------------------------------------------------------------------

apiRouter.post('/auth/register', authRateLimiter, (req, res) => {
  const { full_name, email, password } = req.body ?? {};
  if (!full_name || typeof full_name !== 'string' || full_name.trim().length < 2) {
    res.status(400).json({ error: 'Full name must be at least 2 characters.' });
    return;
  }
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    res.status(400).json({ error: 'Please enter a valid email address.' });
    return;
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters.' });
    return;
  }

  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(normalizedEmail);
  if (existing) {
    res.status(409).json({ error: 'An account with this email already exists.' });
    return;
  }

  const passwordHash = hashPassword(password);
  const result = db
    .prepare(`INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)`)
    .run(full_name.trim(), normalizedEmail, passwordHash);
  const userId = Number(result.lastInsertRowid);

  const user = db
    .prepare(
      `SELECT id, full_name, email, profile_image, preferred_language, notify_scan_complete, notify_critical_bugs, notify_patch_tests, theme_mode, created_at FROM users WHERE id = ?`
    )
    .get(userId) as Record<string, unknown>;

  const accessToken = generateAccessToken({
    id: userId,
    email: normalizedEmail,
    full_name: full_name.trim(),
  });
  const refreshToken = createRefreshToken(userId);

  createNotification(
    userId,
    'Welcome to AutoPatch',
    'Upload a ZIP archive or connect a public GitHub repository to run your first automated bug scan.',
    'info'
  );

  res.status(201).json({ access_token: accessToken, refresh_token: refreshToken, user });
});

apiRouter.post('/auth/login', authRateLimiter, (req, res) => {
  const { email, password } = req.body ?? {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const userRow = db
    .prepare(`SELECT * FROM users WHERE email = ?`)
    .get(normalizedEmail) as
    | {
        id: number;
        full_name: string;
        email: string;
        password_hash: string;
        profile_image: string;
        preferred_language: string;
        notify_scan_complete: number;
        notify_critical_bugs: number;
        notify_patch_tests: number;
        theme_mode: string;
        created_at: string;
      }
    | undefined;

  if (!userRow || !verifyPassword(String(password || ''), userRow.password_hash)) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }

  const accessToken = generateAccessToken({
    id: userRow.id,
    email: userRow.email,
    full_name: userRow.full_name,
  });
  const refreshToken = createRefreshToken(userRow.id);

  const { password_hash: _, ...safeUser } = userRow;
  res.json({ access_token: accessToken, refresh_token: refreshToken, user: safeUser });
});

let cachedFirebaseApiKey: string | null = null;
function getFirebaseApiKey(): string | null {
  if (cachedFirebaseApiKey !== null) return cachedFirebaseApiKey;
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { apiKey?: string };
      cachedFirebaseApiKey = parsed.apiKey || '';
      return cachedFirebaseApiKey;
    }
  } catch {
    // Ignore config read failures
  }
  cachedFirebaseApiKey = '';
  return cachedFirebaseApiKey;
}

apiRouter.post('/auth/firebase', authRateLimiter, async (req, res) => {
  const { id_token } = req.body ?? {};
  if (!id_token || typeof id_token !== 'string') {
    res.status(400).json({ error: 'Missing Firebase ID token.' });
    return;
  }

  const apiKey = getFirebaseApiKey();
  if (!apiKey) {
    res.status(503).json({ error: 'Firebase project configuration is not available on server.' });
    return;
  }

  try {
    const lookupRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: id_token }),
      }
    );

    if (!lookupRes.ok) {
      res.status(401).json({ error: 'Invalid or expired Firebase authentication token.' });
      return;
    }

    const lookupData = (await lookupRes.json()) as {
      users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
        displayName?: string;
        photoUrl?: string;
      }>;
    };

    const fbUser = lookupData.users?.[0];
    if (!fbUser?.email || !fbUser.emailVerified) {
      res.status(401).json({ error: 'Verified email address is required.' });
      return;
    }

    const normalizedEmail = fbUser.email.trim().toLowerCase();
    const displayName = (fbUser.displayName || normalizedEmail.split('@')[0] || 'Developer').trim();
    const photoUrl = fbUser.photoUrl || '/src/assets/images/avatar_developer_default_1795083113786.jpg';

    let userRow = db
      .prepare(
        `SELECT id, full_name, email, profile_image, preferred_language, notify_scan_complete, notify_critical_bugs, notify_patch_tests, theme_mode, created_at
         FROM users WHERE email = ?`
      )
      .get(normalizedEmail) as
      | {
          id: number;
          full_name: string;
          email: string;
          profile_image: string;
          preferred_language: string;
          notify_scan_complete: number;
          notify_critical_bugs: number;
          notify_patch_tests: number;
          theme_mode: string;
          created_at: string;
        }
      | undefined;

    if (!userRow) {
      const unusablePassword = hashPassword(crypto.randomUUID() + crypto.randomUUID());
      const insertRes = db
        .prepare(
          `INSERT INTO users (full_name, email, password_hash, profile_image) VALUES (?, ?, ?, ?)`
        )
        .run(displayName, normalizedEmail, unusablePassword, photoUrl);
      const userId = Number(insertRes.lastInsertRowid);

      createNotification(
        userId,
        'Welcome to AutoPatch',
        'Your Google workspace account is synced. Upload a ZIP archive or clone a GitHub repository to start scanning.',
        'info'
      );

      userRow = db
        .prepare(
          `SELECT id, full_name, email, profile_image, preferred_language, notify_scan_complete, notify_critical_bugs, notify_patch_tests, theme_mode, created_at
           FROM users WHERE id = ?`
        )
        .get(userId) as typeof userRow;
    } else if (
      fbUser.photoUrl &&
      userRow.profile_image === '/src/assets/images/avatar_developer_default_1795083113786.jpg'
    ) {
      db.prepare(`UPDATE users SET profile_image = ?, updated_at = datetime('now') WHERE id = ?`).run(
        fbUser.photoUrl,
        userRow.id
      );
      userRow = { ...userRow, profile_image: fbUser.photoUrl };
    }

    const accessToken = generateAccessToken({
      id: userRow!.id,
      email: userRow!.email,
      full_name: userRow!.full_name,
    });
    const refreshToken = createRefreshToken(userRow!.id);

    res.json({ access_token: accessToken, refresh_token: refreshToken, user: userRow });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unable to verify Firebase session.';
    res.status(502).json({ error: msg });
  }
});

apiRouter.post('/auth/refresh', (req, res) => {
  const { refresh_token } = req.body ?? {};
  if (!refresh_token) {
    res.status(400).json({ error: 'Missing refresh token.' });
    return;
  }
  const userId = verifyRefreshToken(String(refresh_token));
  if (!userId) {
    res.status(401).json({ error: 'Invalid or expired refresh token.' });
    return;
  }
  const user = db
    .prepare(`SELECT id, full_name, email FROM users WHERE id = ?`)
    .get(userId) as { id: number; full_name: string; email: string } | undefined;
  if (!user) {
    res.status(401).json({ error: 'User not found.' });
    return;
  }
  const accessToken = generateAccessToken(user);
  res.json({ access_token: accessToken });
});

apiRouter.post('/auth/logout', (req, res) => {
  const { refresh_token } = req.body ?? {};
  if (refresh_token) {
    revokeRefreshToken(String(refresh_token));
  }
  res.json({ message: 'Logged out successfully.' });
});

apiRouter.get('/auth/me', requireAuth, (req: AuthRequest, res) => {
  const user = db
    .prepare(
      `SELECT id, full_name, email, profile_image, preferred_language, notify_scan_complete, notify_critical_bugs, notify_patch_tests, theme_mode, created_at FROM users WHERE id = ?`
    )
    .get(req.user!.id);
  res.json({ user });
});

apiRouter.patch('/auth/me', requireAuth, (req: AuthRequest, res) => {
  const {
    full_name,
    preferred_language,
    notify_scan_complete,
    notify_critical_bugs,
    notify_patch_tests,
    theme_mode,
  } = req.body ?? {};

  db.prepare(
    `UPDATE users SET
      full_name = COALESCE(?, full_name),
      preferred_language = COALESCE(?, preferred_language),
      notify_scan_complete = COALESCE(?, notify_scan_complete),
      notify_critical_bugs = COALESCE(?, notify_critical_bugs),
      notify_patch_tests = COALESCE(?, notify_patch_tests),
      theme_mode = COALESCE(?, theme_mode),
      updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    full_name ? String(full_name).trim() : null,
    preferred_language || null,
    typeof notify_scan_complete === 'boolean' ? (notify_scan_complete ? 1 : 0) : null,
    typeof notify_critical_bugs === 'boolean' ? (notify_critical_bugs ? 1 : 0) : null,
    typeof notify_patch_tests === 'boolean' ? (notify_patch_tests ? 1 : 0) : null,
    theme_mode || null,
    req.user!.id
  );

  const user = db
    .prepare(
      `SELECT id, full_name, email, profile_image, preferred_language, notify_scan_complete, notify_critical_bugs, notify_patch_tests, theme_mode, created_at FROM users WHERE id = ?`
    )
    .get(req.user!.id);
  res.json({ user });
});

apiRouter.post('/auth/change-password', requireAuth, (req: AuthRequest, res) => {
  const { current_password, new_password } = req.body ?? {};
  const userRow = db
    .prepare(`SELECT password_hash FROM users WHERE id = ?`)
    .get(req.user!.id) as { password_hash: string } | undefined;

  if (!userRow || !verifyPassword(String(current_password || ''), userRow.password_hash)) {
    res.status(400).json({ error: 'Current password is incorrect.' });
    return;
  }
  if (!new_password || String(new_password).length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters.' });
    return;
  }
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(
    hashPassword(String(new_password)),
    req.user!.id
  );
  res.json({ message: 'Password updated successfully.' });
});

// ---------------------------------------------------------------------------
// 2. DASHBOARD SUMMARY, REAL-TIME SSE STREAM & FILE/LINE DIAGNOSTICS
// ---------------------------------------------------------------------------

export function buildProjectDiagnostics(projectId: number, userId: number) {
  const project = db
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(projectId, userId) as
    | {
        id: number;
        project_name: string;
        programming_language: string;
        project_status: string;
        storage_path: string;
      }
    | undefined;
  if (!project) return null;

  const latestScan = db
    .prepare(`SELECT * FROM scan_jobs WHERE project_id = ? ORDER BY id DESC LIMIT 1`)
    .get(projectId) as
    | {
        id: number;
        scan_status: string;
        current_stage: string;
        progress_percentage: number;
        total_files: number;
        scanned_files: number;
        total_bugs: number;
      }
    | undefined;

  const fileRows = db
    .prepare(`SELECT * FROM project_files WHERE project_id = ? ORDER BY file_path ASC LIMIT 80`)
    .all(projectId) as Array<{
    id: number;
    file_name: string;
    file_path: string;
    file_extension: string;
    file_size: number;
    programming_language: string;
  }>;

  const bugRows = db
    .prepare(`SELECT * FROM bugs WHERE project_id = ? ORDER BY start_line ASC, id ASC`)
    .all(projectId) as Array<{
    id: number;
    bug_code: string;
    bug_title: string;
    bug_description: string;
    bug_category: string;
    severity: 'Critical' | 'High' | 'Medium' | 'Low';
    confidence_score: number;
    analyzer_source: string;
    evidence: string;
    file_path: string;
    start_line: number;
    end_line: number;
    original_code: string;
    root_cause: string;
    suggested_solution: string;
    bug_status: 'Open' | 'In Review' | 'Patched' | 'Fixed' | 'Dismissed';
  }>;

  const patchRows = db
    .prepare(`SELECT * FROM patches WHERE project_id = ? ORDER BY id DESC`)
    .all(projectId) as Array<{
    id: number;
    bug_id: number;
    original_code: string;
    proposed_code: string;
    code_diff: string;
    explanation: string;
    patch_status: string;
    validation_status: string;
  }>;

  const latestPatchByBug = new Map<number, (typeof patchRows)[number]>();
  for (const p of patchRows) {
    if (!latestPatchByBug.has(p.bug_id)) {
      latestPatchByBug.set(p.bug_id, p);
    }
  }

  const rootAbs = path.resolve(project.storage_path);
  let wrongFilesCount = 0;
  let rightFilesCount = 0;
  let wrongLinesCount = 0;
  let fixedLinesCount = 0;

  const files = fileRows.map((f) => {
    const abs = path.resolve(project.storage_path, f.file_path);
    let content = '';
    if (
      (abs.startsWith(rootAbs + path.sep) || abs === rootAbs) &&
      fs.existsSync(abs) &&
      f.file_size <= 250000
    ) {
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        content = '';
      }
    }

    const lines = content ? content.replace(/\r\n/g, '\n').split('\n') : [];
    const fileBugs = bugRows.filter((b) => b.file_path === f.file_path);
    const activeBugs = fileBugs.filter(
      (b) => b.bug_status !== 'Fixed' && b.bug_status !== 'Dismissed'
    );
    const fixedBugs = fileBugs.filter((b) => b.bug_status === 'Fixed');

    const lineDiagnostics = fileBugs.map((b) => {
      const lp = latestPatchByBug.get(b.id);
      return {
        bug_id: b.id,
        bug_code: b.bug_code,
        bug_title: b.bug_title,
        bug_description: b.bug_description,
        bug_category: b.bug_category,
        severity: b.severity,
        confidence_score: b.confidence_score,
        analyzer_source: b.analyzer_source,
        evidence: b.evidence,
        start_line: b.start_line,
        end_line: b.end_line,
        original_code: b.original_code,
        root_cause: b.root_cause,
        suggested_solution: b.suggested_solution,
        bug_status: b.bug_status,
        is_wrong: b.bug_status !== 'Fixed' && b.bug_status !== 'Dismissed',
        latest_patch: lp
          ? {
              id: lp.id,
              patch_status: lp.patch_status,
              validation_status: lp.validation_status,
              original_code: lp.original_code,
              proposed_code: lp.proposed_code,
              code_diff: lp.code_diff,
              explanation: lp.explanation,
            }
          : null,
      };
    });

    const wrongLineSet = new Set<number>();
    const rightLineSet = new Set<number>();
    for (const d of lineDiagnostics) {
      const from = Math.max(1, d.start_line || 1);
      const to = Math.max(from, d.end_line || from);
      for (let ln = from; ln <= to; ln++) {
        if (d.is_wrong) {
          wrongLineSet.add(ln);
        } else if (d.bug_status === 'Fixed') {
          rightLineSet.add(ln);
        }
      }
    }

    wrongLinesCount += wrongLineSet.size;
    fixedLinesCount += rightLineSet.size;

    let fileStatus: 'wrong' | 'right' | 'clean' = 'clean';
    if (activeBugs.length > 0) {
      fileStatus = 'wrong';
      wrongFilesCount += 1;
    } else if (fixedBugs.length > 0) {
      fileStatus = 'right';
      rightFilesCount += 1;
    } else {
      fileStatus = 'clean';
      rightFilesCount += 1;
    }

    const latestPatchInFile =
      lineDiagnostics.find((d) => d.latest_patch)?.latest_patch ?? null;

    return {
      file_name: f.file_name,
      file_path: f.file_path,
      programming_language: f.programming_language,
      file_size: f.file_size,
      line_count: lines.length,
      status: fileStatus,
      error_count: activeBugs.length,
      fixed_count: fixedBugs.length,
      wrong_lines: Array.from(wrongLineSet).sort((a, b) => a - b),
      right_lines: Array.from(rightLineSet).sort((a, b) => a - b),
      content,
      diagnostics: lineDiagnostics,
      latest_patch: latestPatchInFile,
    };
  });

  // Sort erroneous files first so developers immediately see Red (Wrong) files at top
  files.sort((a, b) => {
    if (a.error_count !== b.error_count) return b.error_count - a.error_count;
    return a.file_path.localeCompare(b.file_path);
  });

  const openBugsCount = bugRows.filter(
    (b) => b.bug_status !== 'Fixed' && b.bug_status !== 'Dismissed'
  ).length;
  const fixedBugsCount = bugRows.filter((b) => b.bug_status === 'Fixed').length;

  return {
    project: {
      id: project.id,
      project_name: project.project_name,
      programming_language: project.programming_language,
      project_status: project.project_status,
    },
    latest_scan: latestScan || null,
    summary: {
      total_files: files.length,
      wrong_files_count: wrongFilesCount,
      right_files_count: rightFilesCount,
      wrong_lines_count: wrongLinesCount,
      fixed_lines_count: fixedLinesCount,
      open_bugs_count: openBugsCount,
      fixed_bugs_count: fixedBugsCount,
    },
    files,
  };
}

function buildDashboardPayload(userId: number, selectedProjectId?: number) {
  const totalProjects = (
    db.prepare(`SELECT COUNT(*) AS cnt FROM projects WHERE user_id = ?`).get(userId) as {
      cnt: number;
    }
  ).cnt;

  const projectsScanned = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM projects WHERE user_id = ? AND project_status = 'Scanned'`
      )
      .get(userId) as { cnt: number }
  ).cnt;

  const bugsDetected = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM bugs b JOIN projects p ON b.project_id = p.id WHERE p.user_id = ?`
      )
      .get(userId) as { cnt: number }
  ).cnt;

  const criticalBugs = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM bugs b JOIN projects p ON b.project_id = p.id WHERE p.user_id = ? AND b.severity = 'Critical'`
      )
      .get(userId) as { cnt: number }
  ).cnt;

  const bugsFixed = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM bugs b JOIN projects p ON b.project_id = p.id WHERE p.user_id = ? AND b.bug_status = 'Fixed'`
      )
      .get(userId) as { cnt: number }
  ).cnt;

  const pendingReview = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM patches pa JOIN projects p ON pa.project_id = p.id WHERE p.user_id = ? AND pa.patch_status = 'Pending Approval'`
      )
      .get(userId) as { cnt: number }
  ).cnt;

  const severityRows = db
    .prepare(
      `SELECT b.severity AS name, COUNT(*) AS value
       FROM bugs b JOIN projects p ON b.project_id = p.id
       WHERE p.user_id = ?
       GROUP BY b.severity`
    )
    .all(userId) as Array<{ name: string; value: number }>;

  const weeklyRows = db
    .prepare(
      `SELECT substr(b.created_at, 1, 10) AS day, COUNT(*) AS detected,
              SUM(CASE WHEN b.bug_status = 'Fixed' THEN 1 ELSE 0 END) AS fixed
       FROM bugs b JOIN projects p ON b.project_id = p.id
       WHERE p.user_id = ?
       GROUP BY substr(b.created_at, 1, 10)
       ORDER BY day ASC
       LIMIT 14`
    )
    .all(userId) as Array<{ day: string; detected: number; fixed: number }>;

  const recentProjects = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM bugs b WHERE b.project_id = p.id) AS bug_count,
              (SELECT COUNT(*) FROM bugs b WHERE b.project_id = p.id AND b.bug_status = 'Fixed') AS fixed_count,
              (SELECT MAX(id) FROM scan_jobs s WHERE s.project_id = p.id) AS latest_scan_id
       FROM projects p
       WHERE p.user_id = ?
       ORDER BY p.created_at DESC
       LIMIT 8`
    )
    .all(userId) as Array<{ id: number } & Record<string, unknown>>;

  const recentActivities = db
    .prepare(
      `SELECT ch.*, p.project_name
       FROM change_history ch
       JOIN projects p ON ch.project_id = p.id
       WHERE ch.user_id = ?
       ORDER BY ch.created_at DESC
       LIMIT 8`
    )
    .all(userId);

  const recentScanRows = db
    .prepare(
      `SELECT s.id AS scan_id, s.project_id, s.scan_status, s.current_stage,
              s.progress_percentage, s.total_files, s.scanned_files, s.total_bugs,
              s.started_at, s.completed_at,
              p.project_name, p.programming_language,
              (SELECT COUNT(*) FROM bugs b WHERE b.scan_id = s.id AND b.bug_status = 'Fixed') AS fixed_bugs,
              (SELECT COUNT(*) FROM patches pa WHERE pa.project_id = p.id AND pa.patch_status = 'Pending Approval') AS pending_patches,
              (SELECT COUNT(*) FROM patches pa WHERE pa.project_id = p.id AND pa.patch_status IN ('Approved', 'Applied') AND pa.validation_status = 'Validation Incomplete') AS validating_patches
       FROM scan_jobs s
       JOIN projects p ON s.project_id = p.id
       WHERE p.user_id = ?
       ORDER BY s.id DESC
       LIMIT 3`
    )
    .all(userId) as Array<{
      scan_id: number;
      project_id: number;
      scan_status: string;
      current_stage: string;
      progress_percentage: number;
      total_files: number;
      scanned_files: number;
      total_bugs: number;
      started_at: string;
      completed_at: string | null;
      project_name: string;
      programming_language: string;
      fixed_bugs: number;
      pending_patches: number;
      validating_patches: number;
    }>;

  const recentTasks = recentScanRows.map((row) => {
    let taskStatus: 'Analyzing' | 'Patching' | 'Validating' | 'Validated' | 'Completed' | 'Failed' =
      'Completed';
    if (row.scan_status === 'Pending' || row.scan_status === 'Running') {
      taskStatus = 'Analyzing';
    } else if (row.scan_status === 'Failed') {
      taskStatus = 'Failed';
    } else if (row.validating_patches > 0) {
      taskStatus = 'Validating';
    } else if (row.pending_patches > 0 || (row.total_bugs > 0 && row.fixed_bugs < row.total_bugs)) {
      taskStatus = 'Patching';
    } else if (row.total_bugs > 0 && row.fixed_bugs >= row.total_bugs) {
      taskStatus = 'Validated';
    }

    return {
      scan_id: row.scan_id,
      project_id: row.project_id,
      project_name: row.project_name,
      programming_language: row.programming_language,
      task_status: taskStatus,
      current_stage: row.current_stage,
      progress_percentage: row.progress_percentage,
      total_files: row.total_files,
      scanned_files: row.scanned_files,
      total_bugs: row.total_bugs,
      fixed_bugs: row.fixed_bugs,
      started_at: row.started_at,
      completed_at: row.completed_at,
    };
  });

  const targetDiagProjectId =
    selectedProjectId && recentProjects.some((p) => p.id === selectedProjectId)
      ? selectedProjectId
      : selectedProjectId
      ? selectedProjectId
      : recentProjects[0]?.id;

  const activeDiagnostics = targetDiagProjectId
    ? buildProjectDiagnostics(targetDiagProjectId, userId)
    : null;

  return {
    server_time: new Date().toISOString(),
    stats: {
      total_projects: totalProjects,
      projects_scanned: projectsScanned,
      bugs_detected: bugsDetected,
      critical_bugs: criticalBugs,
      bugs_fixed: bugsFixed,
      pending_review: pendingReview,
    },
    severity_distribution: severityRows,
    weekly_trend: weeklyRows,
    recent_projects: recentProjects,
    recent_activities: recentActivities,
    recent_tasks: recentTasks,
    active_diagnostics: activeDiagnostics,
  };
}

apiRouter.get('/dashboard/summary', requireAuth, (req: AuthRequest, res) => {
  const projectIdParam = req.query.projectId ? Number(req.query.projectId) : undefined;
  res.json(buildDashboardPayload(req.user!.id, Number.isFinite(projectIdParam) ? projectIdParam : undefined));
});

apiRouter.get('/dashboard/stream', (req, res) => {
  const header = req.headers.authorization;
  const bearerToken = header && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const user = verifyAccessToken(bearerToken || queryToken);

  if (!user) {
    res.status(401).json({ error: 'Authentication required for real-time stream.' });
    return;
  }

  const projectIdParam = req.query.projectId ? Number(req.query.projectId) : undefined;
  const selectedProjectId = Number.isFinite(projectIdParam) ? projectIdParam : undefined;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendSnapshot = (eventType = 'snapshot') => {
    try {
      const payload = buildDashboardPayload(user.id, selectedProjectId);
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // Ignore closed stream writes
    }
  };

  sendSnapshot('snapshot');

  const unsubscribe = subscribeUserUpdates(user.id, () => {
    sendSnapshot('snapshot');
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

apiRouter.get('/projects/:projectId/diagnostics', requireAuth, (req: AuthRequest, res) => {
  const diagnostics = buildProjectDiagnostics(Number(req.params.projectId), req.user!.id);
  if (!diagnostics) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  res.json({ diagnostics });
});

// ---------------------------------------------------------------------------
// 3. PROJECT UPLOAD, GITHUB CLONE, SAMPLE & MANAGEMENT
// ---------------------------------------------------------------------------

const ALLOWED_SINGLE_FILE_LANG: Record<string, string> = {
  '.py': 'Python',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.java': 'Java',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.cc': 'C++',
};

apiRouter.post('/projects/upload', requireAuth, upload.single('file'), (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'Please select a .zip archive or source file to upload.' });
    return;
  }
  if (!file.buffer || file.buffer.length === 0) {
    res.status(400).json({ error: 'The uploaded file is empty (0 bytes).' });
    return;
  }

  const lowerName = file.originalname.toLowerCase();
  const ext = path.extname(lowerName);
  const isZip = ext === '.zip';
  const singleFileLang = ALLOWED_SINGLE_FILE_LANG[ext];

  if (!isZip && !singleFileLang) {
    res.status(400).json({
      error: `Unsupported file format "${ext || file.originalname}". Upload a .zip archive or source file (.py, .js, .ts, .java, .c, .cpp).`,
    });
    return;
  }

  const baseNameNoExt = path.basename(file.originalname, ext) || 'uploaded-project';
  const projectName = String(req.body?.project_name || baseNameNoExt).trim() || baseNameNoExt;
  const description = String(req.body?.description || '').trim();
  const requestedLang = String(req.body?.programming_language || '').trim();
  const language = singleFileLang || requestedLang || 'Python';

  const folderSlug = `${userId}_${Date.now()}_${projectName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const targetDir = path.resolve(PROJECTS_DIR, folderSlug);
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    if (isZip) {
      const zip = new AdmZip(file.buffer);
      const entries = zip.getEntries();
      if (entries.length === 0) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        res.status(400).json({ error: 'The uploaded ZIP archive is empty.' });
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName.replace(/\\/g, '/');
        if (entryName.startsWith('/') || entryName.includes('..')) {
          fs.rmSync(targetDir, { recursive: true, force: true });
          res.status(400).json({ error: `Unsafe path detected inside ZIP archive: ${entryName}` });
          return;
        }
        const destPath = path.resolve(targetDir, entryName);
        if (!destPath.startsWith(targetDir + path.sep) && destPath !== targetDir) {
          fs.rmSync(targetDir, { recursive: true, force: true });
          res.status(400).json({ error: 'ZIP path traversal blocked.' });
          return;
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, entry.getData());
      }
    } else {
      const safeFileName = path.basename(file.originalname).replace(/[^a-zA-Z0-9_.-]/g, '_');
      fs.writeFileSync(path.join(targetDir, safeFileName), file.buffer);
    }

    const files = collectProjectFiles(targetDir);
    if (files.length === 0) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      res.status(400).json({ error: 'No files found inside the uploaded project.' });
      return;
    }

    const insertRes = db
      .prepare(
        `INSERT INTO projects (user_id, project_name, description, programming_language, source_type, storage_path, project_status)
         VALUES (?, ?, ?, ?, ?, ?, 'Uploaded')`
      )
      .run(userId, projectName, description, language, isZip ? 'zip' : 'file', targetDir);
    const projectId = Number(insertRes.lastInsertRowid);

    const insertFile = db.prepare(
      `INSERT INTO project_files (project_id, file_name, file_path, file_extension, file_size, programming_language)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const f of files) {
      insertFile.run(
        projectId,
        f.file_name,
        f.file_path,
        f.file_extension,
        f.file_size,
        f.programming_language
      );
    }

    recordHistory({
      projectId,
      userId,
      actionType: 'PROJECT_UPLOADED',
      newValue: `${files.length} files`,
      description: `Uploaded ${isZip ? 'ZIP' : 'source'} project "${projectName}" (${files.length} files).`,
    });

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    emitUserUpdate(userId, 'project_uploaded', { projectId });
    res.status(201).json({ project, files_count: files.length });
  } catch (err: unknown) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : 'Failed to extract ZIP archive.';
    res.status(400).json({ error: msg });
  }
});

apiRouter.post('/projects/github', requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { repository_url, branch, project_name, description, programming_language } = req.body ?? {};
  const repoUrl = String(repository_url || '').trim();

  if (!/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\.git)?\/?$/.test(repoUrl)) {
    res.status(400).json({
      error: 'Please enter a valid HTTPS GitHub repository URL (e.g., https://github.com/owner/repo).',
    });
    return;
  }

  const branchName = String(branch || 'main').trim() || 'main';
  const inferredName = repoUrl.split('/').pop()?.replace(/\.git$/, '') || 'github-project';
  const finalName = String(project_name || inferredName).trim();
  const folderSlug = `${userId}_${Date.now()}_${finalName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const targetDir = path.resolve(PROJECTS_DIR, folderSlug);

  try {
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', '--branch', branchName, repoUrl, targetDir],
      { timeout: 30000 }
    );

    let commitHash = '';
    try {
      const { stdout } = await execFileAsync('git', ['-C', targetDir, 'rev-parse', '--short', 'HEAD']);
      commitHash = stdout.trim();
    } catch {
      commitHash = '';
    }

    const insertRes = db
      .prepare(
        `INSERT INTO projects (user_id, project_name, description, programming_language, source_type, repository_url, default_branch, commit_hash, storage_path, project_status)
         VALUES (?, ?, ?, ?, 'github', ?, ?, ?, ?, 'Uploaded')`
      )
      .run(
        userId,
        finalName,
        String(description || '').trim(),
        String(programming_language || 'Python').trim(),
        repoUrl,
        branchName,
        commitHash,
        targetDir
      );
    const projectId = Number(insertRes.lastInsertRowid);

    db.prepare(
      `INSERT INTO repository_connections (user_id, provider, repository_name, repository_url, default_branch)
       VALUES (?, 'github', ?, ?, ?)`
    ).run(userId, finalName, repoUrl, branchName);

    const files = collectProjectFiles(targetDir);
    const insertFile = db.prepare(
      `INSERT INTO project_files (project_id, file_name, file_path, file_extension, file_size, programming_language)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const f of files) {
      insertFile.run(
        projectId,
        f.file_name,
        f.file_path,
        f.file_extension,
        f.file_size,
        f.programming_language
      );
    }

    recordHistory({
      projectId,
      userId,
      actionType: 'GITHUB_CLONED',
      newValue: `${branchName} @ ${commitHash || 'HEAD'}`,
      description: `Cloned public GitHub repository ${repoUrl} (${branchName}).`,
    });

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    emitUserUpdate(userId, 'project_github_cloned', { projectId });
    res.status(201).json({ project, files_count: files.length });
  } catch (err: unknown) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    const msg =
      err instanceof Error
        ? err.message
        : 'Unable to clone GitHub repository. Verify URL, public visibility, and branch name.';
    res.status(400).json({ error: `Git clone failed: ${msg}` });
  }
});

apiRouter.post('/projects/sample', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const projectName = String(req.body?.project_name || 'Student Analytics Core (Python)').trim();
  const folderSlug = `${userId}_${Date.now()}_sample_python`;
  const targetDir = path.resolve(PROJECTS_DIR, folderSlug);

  writeSampleBuggyPythonProject(targetDir);

  const insertRes = db
    .prepare(
      `INSERT INTO projects (user_id, project_name, description, programming_language, source_type, storage_path, project_status)
       VALUES (?, ?, ?, 'Python', 'sample', ?, 'Uploaded')`
    )
    .run(
      userId,
      projectName,
      'Multi-module Python service containing real arithmetic, validation, scope, loop, and exception bugs plus unittest suite.',
      targetDir
    );
  const projectId = Number(insertRes.lastInsertRowid);

  const files = collectProjectFiles(targetDir);
  const insertFile = db.prepare(
    `INSERT INTO project_files (project_id, file_name, file_path, file_extension, file_size, programming_language)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const f of files) {
    insertFile.run(
      projectId,
      f.file_name,
      f.file_path,
      f.file_extension,
      f.file_size,
      f.programming_language
    );
  }

  recordHistory({
    projectId,
    userId,
    actionType: 'PROJECT_CREATED',
    newValue: `${files.length} Python files`,
    description: `Initialized sample Python project "${projectName}" in workspace storage.`,
  });

  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
  emitUserUpdate(userId, 'project_sample_created', { projectId });
  res.status(201).json({ project, files_count: files.length });
});

apiRouter.get('/projects', requireAuth, (req: AuthRequest, res) => {
  const projects = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM project_files pf WHERE pf.project_id = p.id) AS file_count,
              (SELECT COUNT(*) FROM bugs b WHERE b.project_id = p.id) AS bug_count,
              (SELECT COUNT(*) FROM bugs b WHERE b.project_id = p.id AND b.bug_status = 'Fixed') AS fixed_count,
              (SELECT MAX(id) FROM scan_jobs s WHERE s.project_id = p.id) AS latest_scan_id
       FROM projects p
       WHERE p.user_id = ?
       ORDER BY p.created_at DESC`
    )
    .all(req.user!.id);
  res.json({ projects });
});

apiRouter.get('/projects/:projectId', requireAuth, (req: AuthRequest, res) => {
  const project = db
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(Number(req.params.projectId), req.user!.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  const latestScan = db
    .prepare(`SELECT * FROM scan_jobs WHERE project_id = ? ORDER BY id DESC LIMIT 1`)
    .get(Number(req.params.projectId));
  res.json({ project, latest_scan: latestScan || null });
});

apiRouter.delete('/projects/:projectId', requireAuth, (req: AuthRequest, res) => {
  const project = db
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(Number(req.params.projectId), req.user!.id) as
    | { id: number; storage_path: string }
    | undefined;
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  if (project.storage_path && project.storage_path.startsWith(PROJECTS_DIR)) {
    fs.rmSync(project.storage_path, { recursive: true, force: true });
  }
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(project.id);
  emitUserUpdate(req.user!.id, 'project_deleted', { projectId: project.id });
  res.json({ message: 'Project deleted.' });
});

apiRouter.get('/projects/:projectId/files', requireAuth, (req: AuthRequest, res) => {
  const project = db
    .prepare(`SELECT id FROM projects WHERE id = ? AND user_id = ?`)
    .get(Number(req.params.projectId), req.user!.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  const files = db
    .prepare(`SELECT * FROM project_files WHERE project_id = ? ORDER BY file_path ASC`)
    .all(Number(req.params.projectId));
  res.json({ files });
});

apiRouter.get('/projects/:projectId/file-content', requireAuth, (req: AuthRequest, res) => {
  const project = db
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(Number(req.params.projectId), req.user!.id) as { storage_path: string } | undefined;
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  const relPath = String(req.query.path || '');
  const absPath = path.resolve(project.storage_path, relPath);
  if (!absPath.startsWith(path.resolve(project.storage_path) + path.sep) || !fs.existsSync(absPath)) {
    res.status(404).json({ error: 'Source file not found.' });
    return;
  }
  const content = fs.readFileSync(absPath, 'utf8');
  res.json({ path: relPath, content });
});

// ---------------------------------------------------------------------------
// 4. PROJECT ANALYSIS & SCANS
// ---------------------------------------------------------------------------

apiRouter.post('/projects/:projectId/scan', requireAuth, async (req: AuthRequest, res) => {
  try {
    const scanId = await startProjectScanJob(Number(req.params.projectId), req.user!.id);
    const scan = db.prepare(`SELECT * FROM scan_jobs WHERE id = ?`).get(scanId);
    res.status(202).json({ scan });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unable to start scan.';
    res.status(400).json({ error: msg });
  }
});

apiRouter.get('/scans/:scanId', requireAuth, (req: AuthRequest, res) => {
  const scan = db
    .prepare(
      `SELECT s.*, p.project_name, p.programming_language
       FROM scan_jobs s
       JOIN projects p ON s.project_id = p.id
       WHERE s.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.scanId), req.user!.id);
  if (!scan) {
    res.status(404).json({ error: 'Scan job not found.' });
    return;
  }
  res.json({ scan });
});

apiRouter.get('/scans/:scanId/bugs', requireAuth, (req: AuthRequest, res) => {
  const scan = db
    .prepare(
      `SELECT s.id FROM scan_jobs s JOIN projects p ON s.project_id = p.id WHERE s.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.scanId), req.user!.id);
  if (!scan) {
    res.status(404).json({ error: 'Scan job not found.' });
    return;
  }
  const bugs = db
    .prepare(`SELECT * FROM bugs WHERE scan_id = ? ORDER BY id ASC`)
    .all(Number(req.params.scanId));
  res.json({ bugs });
});

apiRouter.get('/projects/:projectId/statistics', requireAuth, (req: AuthRequest, res) => {
  const projectId = Number(req.params.projectId);
  const project = db
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(projectId, req.user!.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  const totalBugs = (
    db.prepare(`SELECT COUNT(*) AS cnt FROM bugs WHERE project_id = ?`).get(projectId) as { cnt: number }
  ).cnt;
  const severity = db
    .prepare(`SELECT severity, COUNT(*) AS count FROM bugs WHERE project_id = ? GROUP BY severity`)
    .all(projectId);
  const status = db
    .prepare(`SELECT bug_status, COUNT(*) AS count FROM bugs WHERE project_id = ? GROUP BY bug_status`)
    .all(projectId);
  res.json({ total_bugs: totalBugs, severity, status });
});

// ---------------------------------------------------------------------------
// 5. BUGS & ROOT CAUSE ANALYSIS
// ---------------------------------------------------------------------------

apiRouter.get('/bugs', requireAuth, (req: AuthRequest, res) => {
  const bugs = db
    .prepare(
      `SELECT b.*, p.project_name
       FROM bugs b
       JOIN projects p ON b.project_id = p.id
       WHERE p.user_id = ?
       ORDER BY b.id DESC`
    )
    .all(req.user!.id);
  res.json({ bugs });
});

apiRouter.get('/projects/:projectId/bugs', requireAuth, (req: AuthRequest, res) => {
  const project = db
    .prepare(`SELECT id FROM projects WHERE id = ? AND user_id = ?`)
    .get(Number(req.params.projectId), req.user!.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  const bugs = db
    .prepare(
      `SELECT b.*, p.project_name FROM bugs b JOIN projects p ON b.project_id = p.id WHERE b.project_id = ? ORDER BY b.id ASC`
    )
    .all(Number(req.params.projectId));
  res.json({ bugs });
});

apiRouter.get('/bugs/:bugId', requireAuth, (req: AuthRequest, res) => {
  const bug = db
    .prepare(
      `SELECT b.*, p.project_name, p.storage_path, p.programming_language
       FROM bugs b
       JOIN projects p ON b.project_id = p.id
       WHERE b.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.bugId), req.user!.id) as
    | (Record<string, unknown> & { storage_path: string; file_path: string })
    | undefined;
  if (!bug) {
    res.status(404).json({ error: 'Bug record not found.' });
    return;
  }

  let fullFileContent = '';
  const abs = path.resolve(bug.storage_path, bug.file_path);
  if (abs.startsWith(path.resolve(bug.storage_path) + path.sep) && fs.existsSync(abs)) {
    fullFileContent = fs.readFileSync(abs, 'utf8');
  }

  const patches = db
    .prepare(`SELECT * FROM patches WHERE bug_id = ? ORDER BY id DESC`)
    .all(Number(req.params.bugId));

  res.json({ bug, file_content: fullFileContent, patches });
});

apiRouter.patch('/bugs/:bugId/status', requireAuth, (req: AuthRequest, res) => {
  const allowed = new Set(['Open', 'In Review', 'Patched', 'Fixed', 'Dismissed']);
  const nextStatus = String(req.body?.bug_status || '');
  if (!allowed.has(nextStatus)) {
    res.status(400).json({ error: 'Invalid bug status.' });
    return;
  }
  const bug = db
    .prepare(
      `SELECT b.* FROM bugs b JOIN projects p ON b.project_id = p.id WHERE b.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.bugId), req.user!.id) as
    | { id: number; project_id: number; bug_status: string; bug_code: string }
    | undefined;
  if (!bug) {
    res.status(404).json({ error: 'Bug not found.' });
    return;
  }

  db.prepare(`UPDATE bugs SET bug_status = ? WHERE id = ?`).run(nextStatus, bug.id);
  recordHistory({
    projectId: bug.project_id,
    bugId: bug.id,
    userId: req.user!.id,
    actionType: 'BUG_STATUS_CHANGED',
    previousValue: bug.bug_status,
    newValue: nextStatus,
    description: `Updated ${bug.bug_code} status from ${bug.bug_status} to ${nextStatus}.`,
  });

  const updated = db.prepare(`SELECT * FROM bugs WHERE id = ?`).get(bug.id);
  emitUserUpdate(req.user!.id, 'bug_status_changed', { projectId: bug.project_id, bugId: bug.id });
  res.json({ bug: updated });
});

apiRouter.post('/bugs/:bugId/analyze', requireAuth, async (req: AuthRequest, res) => {
  const bug = db
    .prepare(
      `SELECT b.*, p.storage_path
       FROM bugs b
       JOIN projects p ON b.project_id = p.id
       WHERE b.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.bugId), req.user!.id) as
    | {
        id: number;
        project_id: number;
        bug_code: string;
        bug_title: string;
        bug_description: string;
        bug_category: string;
        severity: string;
        analyzer_source: string;
        file_path: string;
        start_line: number;
        end_line: number;
        evidence: string;
        storage_path: string;
      }
    | undefined;

  if (!bug) {
    res.status(404).json({ error: 'Bug not found.' });
    return;
  }

  const resolvedRoot = path.resolve(bug.storage_path);
  const abs = path.resolve(resolvedRoot, bug.file_path);
  if ((!abs.startsWith(resolvedRoot + path.sep) && abs !== resolvedRoot) || !fs.existsSync(abs)) {
    res.status(404).json({ error: 'Target source file no longer exists on disk.' });
    return;
  }
  const fileContent = fs.readFileSync(abs, 'utf8');

  const recentTests = db
    .prepare(
      `SELECT phase, test_name, test_status, error_message, output
       FROM test_results
       WHERE project_id = ?
       ORDER BY id DESC LIMIT 12`
    )
    .all(bug.project_id) as Array<{
    phase: string;
    test_name: string;
    test_status: string;
    error_message: string;
    output: string;
  }>;

  const recentTestOutputs = recentTests
    .map(
      (t) =>
        `[${t.phase}] ${t.test_name}: ${t.test_status}${t.error_message ? ` | Error: ${t.error_message}` : ''}${t.output ? ` | Output: ${t.output}` : ''}`
    )
    .join('\n');

  try {
    const analysis = await analyzeBugRootCauseWithAI({
      bugTitle: bug.bug_title,
      bugDescription: bug.bug_description,
      bugCategory: bug.bug_category,
      severity: bug.severity,
      analyzerSource: bug.analyzer_source,
      filePath: bug.file_path,
      startLine: bug.start_line,
      endLine: bug.end_line,
      evidence: bug.evidence,
      fileContent,
      recentTestOutputs,
    });

    db.prepare(
      `UPDATE bugs SET
        bug_description = ?,
        root_cause = ?,
        why_it_occurs = ?,
        triggering_condition = ?,
        expected_behavior = ?,
        actual_behavior = ?,
        potential_impact = ?,
        suggested_solution = ?,
        confidence_score = ?
       WHERE id = ?`
    ).run(
      analysis.bug_description,
      analysis.root_cause,
      analysis.why_it_occurs,
      analysis.triggering_condition,
      analysis.expected_behavior,
      analysis.actual_behavior,
      analysis.potential_impact,
      analysis.suggested_solution,
      analysis.confidence_score,
      bug.id
    );

    recordHistory({
      projectId: bug.project_id,
      bugId: bug.id,
      userId: req.user!.id,
      actionType: 'ROOT_CAUSE_ANALYZED',
      description: `Ran Gemini AI root-cause analysis on ${bug.bug_code} (${bug.file_path}).`,
    });

    const updated = db.prepare(`SELECT * FROM bugs WHERE id = ?`).get(bug.id);
    emitUserUpdate(req.user!.id, 'bug_analyzed', { projectId: bug.project_id, bugId: bug.id });
    res.json({ bug: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'AI root-cause analysis failed.';
    res.status(502).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// 6. PATCH GENERATION, APPROVAL, APPLICATION & ROLLBACK
// ---------------------------------------------------------------------------

apiRouter.post('/bugs/:bugId/patches', requireAuth, async (req: AuthRequest, res) => {
  const bug = db
    .prepare(
      `SELECT b.*, p.storage_path
       FROM bugs b
       JOIN projects p ON b.project_id = p.id
       WHERE b.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.bugId), req.user!.id) as
    | {
        id: number;
        project_id: number;
        bug_code: string;
        bug_title: string;
        bug_category: string;
        bug_description: string;
        evidence: string;
        root_cause: string;
        suggested_solution: string;
        file_path: string;
        start_line: number;
        end_line: number;
        storage_path: string;
      }
    | undefined;

  if (!bug) {
    res.status(404).json({ error: 'Bug not found.' });
    return;
  }

  const resolvedRoot = path.resolve(bug.storage_path);
  const abs = path.resolve(resolvedRoot, bug.file_path);
  if ((!abs.startsWith(resolvedRoot + path.sep) && abs !== resolvedRoot) || !fs.existsSync(abs)) {
    res.status(404).json({ error: 'Target source file not found.' });
    return;
  }
  const originalContent = fs.readFileSync(abs, 'utf8');
  const fileHash = sha256File(abs);

  const recentTests = db
    .prepare(
      `SELECT phase, test_name, test_status, error_message, output
       FROM test_results
       WHERE project_id = ?
       ORDER BY id DESC LIMIT 10`
    )
    .all(bug.project_id) as Array<{
    phase: string;
    test_name: string;
    test_status: string;
    error_message: string;
    output: string;
  }>;
  const recentTestOutputs = recentTests
    .map(
      (t) =>
        `[${t.phase}] ${t.test_name}: ${t.test_status}${t.error_message ? ` | Error: ${t.error_message}` : ''}`
    )
    .join('\n');

  try {
    let aiPatch = await generatePatchWithAI({
      bugTitle: bug.bug_title,
      bugDescription: bug.bug_description,
      rootCause: bug.root_cause,
      suggestedSolution: bug.suggested_solution,
      evidence: bug.evidence,
      filePath: bug.file_path,
      startLine: bug.start_line,
      endLine: bug.end_line,
      fileContent: originalContent,
      recentTestOutputs,
    });

    let validation = await validateProposedPatchContent({
      filePath: bug.file_path,
      originalContent,
      proposedContent: aiPatch.proposed_file_content,
      projectDir: bug.storage_path,
      targetBug: {
        bug_title: bug.bug_title,
        bug_category: bug.bug_category,
        start_line: bug.start_line,
      },
    });

    if (!validation.valid) {
      aiPatch = await generatePatchWithAI({
        bugTitle: bug.bug_title,
        bugDescription: bug.bug_description,
        rootCause: bug.root_cause,
        suggestedSolution: bug.suggested_solution,
        evidence: bug.evidence,
        filePath: bug.file_path,
        startLine: bug.start_line,
        endLine: bug.end_line,
        fileContent: originalContent,
        recentTestOutputs,
        validationFeedback: validation.reason,
      });

      validation = await validateProposedPatchContent({
        filePath: bug.file_path,
        originalContent,
        proposedContent: aiPatch.proposed_file_content,
        projectDir: bug.storage_path,
        targetBug: {
          bug_title: bug.bug_title,
          bug_category: bug.bug_category,
          start_line: bug.start_line,
        },
      });
    }

    if (!validation.valid) {
      res.status(502).json({
        error: `AI patch failed automated static validation and was not saved: ${validation.reason}`,
      });
      return;
    }

    const unifiedDiff = createPatch(
      bug.file_path,
      originalContent,
      aiPatch.proposed_file_content,
      'original',
      'proposed'
    );

    const insertRes = db
      .prepare(
        `INSERT INTO patches (bug_id, project_id, original_code, proposed_code, code_diff, explanation, repair_reason, original_file_hash, patch_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending Approval')`
      )
      .run(
        bug.id,
        bug.project_id,
        originalContent,
        aiPatch.proposed_file_content,
        unifiedDiff,
        aiPatch.explanation,
        aiPatch.repair_reason,
        fileHash
      );
    const patchId = Number(insertRes.lastInsertRowid);

    recordHistory({
      projectId: bug.project_id,
      bugId: bug.id,
      patchId,
      userId: req.user!.id,
      actionType: 'PATCH_GENERATED',
      newValue: 'Pending Approval',
      description: `Generated validated candidate patch #${patchId} for ${bug.bug_code} (${bug.file_path}).`,
    });

    const patch = db.prepare(`SELECT * FROM patches WHERE id = ?`).get(patchId);
    emitUserUpdate(req.user!.id, 'patch_generated', { projectId: bug.project_id, bugId: bug.id, patchId });
    res.status(201).json({ patch });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Patch generation failed.';
    res.status(502).json({ error: msg });
  }
});

apiRouter.get('/bugs/:bugId/patches', requireAuth, (req: AuthRequest, res) => {
  const bug = db
    .prepare(
      `SELECT b.id FROM bugs b JOIN projects p ON b.project_id = p.id WHERE b.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.bugId), req.user!.id);
  if (!bug) {
    res.status(404).json({ error: 'Bug not found.' });
    return;
  }
  const patches = db
    .prepare(`SELECT * FROM patches WHERE bug_id = ? ORDER BY id DESC`)
    .all(Number(req.params.bugId));
  res.json({ patches });
});

apiRouter.get('/patches', requireAuth, (req: AuthRequest, res) => {
  const patches = db
    .prepare(
      `SELECT pa.*, b.bug_code, b.bug_title, b.file_path, b.severity, p.project_name
       FROM patches pa
       JOIN bugs b ON pa.bug_id = b.id
       JOIN projects p ON pa.project_id = p.id
       WHERE p.user_id = ?
       ORDER BY pa.id DESC`
    )
    .all(req.user!.id);
  res.json({ patches });
});

apiRouter.get('/patches/:patchId', requireAuth, (req: AuthRequest, res) => {
  const patch = db
    .prepare(
      `SELECT pa.*, b.bug_code, b.bug_title, b.file_path, b.severity, b.start_line, b.end_line, p.project_name
       FROM patches pa
       JOIN bugs b ON pa.bug_id = b.id
       JOIN projects p ON pa.project_id = p.id
       WHERE pa.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.patchId), req.user!.id);
  if (!patch) {
    res.status(404).json({ error: 'Patch not found.' });
    return;
  }
  res.json({ patch });
});

apiRouter.get('/patches/:patchId/diff', requireAuth, (req: AuthRequest, res) => {
  const patch = db
    .prepare(
      `SELECT pa.id, pa.code_diff, pa.original_code, pa.proposed_code, b.file_path
       FROM patches pa
       JOIN bugs b ON pa.bug_id = b.id
       JOIN projects p ON pa.project_id = p.id
       WHERE pa.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.patchId), req.user!.id);
  if (!patch) {
    res.status(404).json({ error: 'Patch not found.' });
    return;
  }
  res.json(patch);
});

apiRouter.post('/patches/:patchId/approve', requireAuth, (req: AuthRequest, res) => {
  const patch = db
    .prepare(
      `SELECT pa.*, b.bug_code FROM patches pa JOIN bugs b ON pa.bug_id = b.id JOIN projects p ON pa.project_id = p.id WHERE pa.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.patchId), req.user!.id) as
    | { id: number; bug_id: number; project_id: number; patch_status: string; bug_code: string }
    | undefined;
  if (!patch) {
    res.status(404).json({ error: 'Patch not found.' });
    return;
  }

  db.prepare(
    `UPDATE patches SET patch_status = 'Approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?`
  ).run(req.user!.id, patch.id);

  recordHistory({
    projectId: patch.project_id,
    bugId: patch.bug_id,
    patchId: patch.id,
    userId: req.user!.id,
    actionType: 'PATCH_APPROVED',
    previousValue: patch.patch_status,
    newValue: 'Approved',
    description: `Developer approved patch #${patch.id} for ${patch.bug_code}.`,
  });

  const updated = db.prepare(`SELECT * FROM patches WHERE id = ?`).get(patch.id);
  emitUserUpdate(req.user!.id, 'patch_approved', { projectId: patch.project_id, patchId: patch.id });
  res.json({ patch: updated });
});

apiRouter.post('/patches/:patchId/reject', requireAuth, (req: AuthRequest, res) => {
  const patch = db
    .prepare(
      `SELECT pa.*, b.bug_code FROM patches pa JOIN bugs b ON pa.bug_id = b.id JOIN projects p ON pa.project_id = p.id WHERE pa.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.patchId), req.user!.id) as
    | { id: number; bug_id: number; project_id: number; patch_status: string; bug_code: string }
    | undefined;
  if (!patch) {
    res.status(404).json({ error: 'Patch not found.' });
    return;
  }

  db.prepare(
    `UPDATE patches SET patch_status = 'Rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?`
  ).run(req.user!.id, patch.id);

  recordHistory({
    projectId: patch.project_id,
    bugId: patch.bug_id,
    patchId: patch.id,
    userId: req.user!.id,
    actionType: 'PATCH_REJECTED',
    previousValue: patch.patch_status,
    newValue: 'Rejected',
    description: `Developer rejected patch #${patch.id} for ${patch.bug_code}.`,
  });

  const updated = db.prepare(`SELECT * FROM patches WHERE id = ?`).get(patch.id);
  emitUserUpdate(req.user!.id, 'patch_rejected', { projectId: patch.project_id, patchId: patch.id });
  res.json({ patch: updated });
});

apiRouter.post('/patches/:patchId/apply', requireAuth, async (req: AuthRequest, res) => {
  const patch = db
    .prepare(
      `SELECT pa.*, b.bug_code, b.file_path, p.storage_path, p.source_type
       FROM patches pa
       JOIN bugs b ON pa.bug_id = b.id
       JOIN projects p ON pa.project_id = p.id
       WHERE pa.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.patchId), req.user!.id) as
    | {
        id: number;
        bug_id: number;
        project_id: number;
        bug_code: string;
        file_path: string;
        storage_path: string;
        source_type: string;
        original_code: string;
        proposed_code: string;
        original_file_hash: string;
        patch_status: string;
      }
    | undefined;

  if (!patch) {
    res.status(404).json({ error: 'Patch not found.' });
    return;
  }
  if (patch.patch_status === 'Rejected') {
    res.status(400).json({ error: 'Cannot apply a rejected patch.' });
    return;
  }

  const abs = path.resolve(patch.storage_path, patch.file_path);
  if (!abs.startsWith(path.resolve(patch.storage_path) + path.sep) || !fs.existsSync(abs)) {
    res.status(404).json({ error: 'Target source file does not exist.' });
    return;
  }

  const currentHash = sha256File(abs);
  if (currentHash !== patch.original_file_hash) {
    res.status(409).json({
      error:
        'Source file has been modified since this patch was generated. Generate a fresh patch before applying.',
    });
    return;
  }

  // Create immutable backup before writing
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const backupFile = path.join(BACKUPS_DIR, `patch_${patch.id}_${Date.now()}.bak`);
  fs.writeFileSync(backupFile, fs.readFileSync(abs, 'utf8'), 'utf8');

  // If GitHub repo, create a separate repair branch (never push directly to default branch)
  if (patch.source_type === 'github' && fs.existsSync(path.join(patch.storage_path, '.git'))) {
    const repairBranch = `autopatch/${patch.bug_code.toLowerCase()}-patch-${patch.id}`;
    try {
      await execFileAsync('git', ['-C', patch.storage_path, 'checkout', '-B', repairBranch]);
    } catch {
      // Non-fatal if detached or branch already exists
    }
  }

  fs.writeFileSync(abs, patch.proposed_code, 'utf8');

  db.prepare(
    `UPDATE patches SET patch_status = 'Applied', backup_path = ?, reviewed_at = COALESCE(reviewed_at, datetime('now')), reviewed_by = COALESCE(reviewed_by, ?) WHERE id = ?`
  ).run(backupFile, req.user!.id, patch.id);

  db.prepare(`UPDATE bugs SET bug_status = 'Patched' WHERE id = ?`).run(patch.bug_id);

  recordHistory({
    projectId: patch.project_id,
    bugId: patch.bug_id,
    patchId: patch.id,
    userId: req.user!.id,
    actionType: 'PATCH_APPLIED',
    previousValue: patch.patch_status,
    newValue: 'Applied',
    description: `Safely applied patch #${patch.id} to ${patch.file_path} (backup preserved).`,
  });

  createNotification(
    req.user!.id,
    `Patch Applied: ${patch.bug_code}`,
    `Patch #${patch.id} applied to ${patch.file_path}. Run validation tests to confirm the fix.`,
    'info'
  );

  const updated = db.prepare(`SELECT * FROM patches WHERE id = ?`).get(patch.id);
  emitUserUpdate(req.user!.id, 'patch_applied', { projectId: patch.project_id, patchId: patch.id });
  res.json({ patch: updated });
});

apiRouter.post('/patches/:patchId/rollback', requireAuth, (req: AuthRequest, res) => {
  const patch = db
    .prepare(
      `SELECT pa.*, b.bug_code, b.file_path, p.storage_path
       FROM patches pa
       JOIN bugs b ON pa.bug_id = b.id
       JOIN projects p ON pa.project_id = p.id
       WHERE pa.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.patchId), req.user!.id) as
    | {
        id: number;
        bug_id: number;
        project_id: number;
        bug_code: string;
        file_path: string;
        storage_path: string;
        backup_path: string;
        original_code: string;
      }
    | undefined;

  if (!patch) {
    res.status(404).json({ error: 'Patch not found.' });
    return;
  }

  const resolvedRoot = path.resolve(patch.storage_path);
  const abs = path.resolve(resolvedRoot, patch.file_path);
  if (!abs.startsWith(resolvedRoot + path.sep)) {
    res.status(400).json({ error: 'Invalid target file path.' });
    return;
  }
  const backupContent =
    patch.backup_path && fs.existsSync(patch.backup_path)
      ? fs.readFileSync(patch.backup_path, 'utf8')
      : patch.original_code;

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, backupContent, 'utf8');

  db.prepare(
    `UPDATE patches SET patch_status = 'Rolled Back', validation_status = 'Validation Incomplete' WHERE id = ?`
  ).run(patch.id);
  db.prepare(`UPDATE bugs SET bug_status = 'Open' WHERE id = ?`).run(patch.bug_id);

  recordHistory({
    projectId: patch.project_id,
    bugId: patch.bug_id,
    patchId: patch.id,
    userId: req.user!.id,
    actionType: 'PATCH_ROLLED_BACK',
    previousValue: 'Applied',
    newValue: 'Rolled Back',
    description: `Rolled back patch #${patch.id} on ${patch.file_path} from immutable backup.`,
  });

  createNotification(
    req.user!.id,
    `Patch Rolled Back: ${patch.bug_code}`,
    `Restored original ${patch.file_path} from immutable backup.`,
    'warning'
  );

  const updated = db.prepare(`SELECT * FROM patches WHERE id = ?`).get(patch.id);
  emitUserUpdate(req.user!.id, 'patch_rolled_back', { projectId: patch.project_id, patchId: patch.id });
  res.json({ patch: updated });
});

// ---------------------------------------------------------------------------
// 7. SANDBOXED TESTING & VALIDATION
// ---------------------------------------------------------------------------

apiRouter.post('/patches/:patchId/test', requireAuth, async (req: AuthRequest, res) => {
  const patch = db
    .prepare(
      `SELECT pa.*, b.bug_code, b.bug_title, b.start_line, b.file_path, p.storage_path, p.programming_language
       FROM patches pa
       JOIN bugs b ON pa.bug_id = b.id
       JOIN projects p ON pa.project_id = p.id
       WHERE pa.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.patchId), req.user!.id) as
    | {
        id: number;
        bug_id: number;
        project_id: number;
        bug_code: string;
        bug_title: string;
        start_line: number;
        file_path: string;
        storage_path: string;
        programming_language: string;
        original_code: string;
        proposed_code: string;
        patch_status: string;
      }
    | undefined;

  if (!patch) {
    res.status(404).json({ error: 'Patch not found.' });
    return;
  }

  const ext = path.extname(patch.file_path).toLowerCase();
  const isPython = patch.file_path.endsWith('.py');
  const isJsTs = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext);

  if (!isPython && !isJsTs) {
    res.status(400).json({
      error: 'Automated sandboxed test execution supports Python (.py) and JavaScript/TypeScript (.js/.ts) files.',
    });
    return;
  }

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const tmpBeforeDir = fs.mkdtempSync(path.join(BACKUPS_DIR, 'before_'));
  const tmpAfterDir = fs.mkdtempSync(path.join(BACKUPS_DIR, 'after_'));

  try {
    fs.cpSync(patch.storage_path, tmpBeforeDir, { recursive: true });
    fs.cpSync(patch.storage_path, tmpAfterDir, { recursive: true });

    const beforeTarget = path.resolve(tmpBeforeDir, patch.file_path);
    const afterTarget = path.resolve(tmpAfterDir, patch.file_path);
    if (
      !beforeTarget.startsWith(path.resolve(tmpBeforeDir) + path.sep) ||
      !afterTarget.startsWith(path.resolve(tmpAfterDir) + path.sep)
    ) {
      throw new Error('Invalid target file path for sandbox test execution.');
    }
    fs.mkdirSync(path.dirname(beforeTarget), { recursive: true });
    fs.mkdirSync(path.dirname(afterTarget), { recursive: true });
    fs.writeFileSync(beforeTarget, patch.original_code, 'utf8');
    fs.writeFileSync(afterTarget, patch.proposed_code, 'utf8');

    const beforeSuite = isPython
      ? await runSandboxedPythonTests(tmpBeforeDir, patch.file_path)
      : await runSandboxedJsTsTests(tmpBeforeDir, patch.file_path);
    const afterSuite = isPython
      ? await runSandboxedPythonTests(tmpAfterDir, patch.file_path)
      : await runSandboxedJsTsTests(tmpAfterDir, patch.file_path);

    db.prepare(`DELETE FROM test_results WHERE patch_id = ?`).run(patch.id);
    const insertTest = db.prepare(
      `INSERT INTO test_results (patch_id, project_id, phase, test_name, test_description, test_status, execution_time, error_message, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const r of beforeSuite.results) {
      insertTest.run(
        patch.id,
        patch.project_id,
        'before',
        r.test_name,
        r.test_description,
        r.test_status,
        r.execution_time,
        r.error_message,
        r.output
      );
    }
    for (const r of afterSuite.results) {
      insertTest.run(
        patch.id,
        patch.project_id,
        'after',
        r.test_name,
        r.test_description,
        r.test_status,
        r.execution_time,
        r.error_message,
        r.output
      );
    }

    const validationStatus =
      afterSuite.passed > 0 && afterSuite.failed === 0
        ? 'Tests Passed'
        : afterSuite.total_tests === 0
        ? 'Validation Incomplete'
        : 'Tests Failed';

    db.prepare(`UPDATE patches SET validation_status = ? WHERE id = ?`).run(
      validationStatus,
      patch.id
    );

    // Only mark bug as Fixed when the patch is applied, tests genuinely passed, AND the bug no longer reproduces statically
    if (afterSuite.failed === 0 && afterSuite.passed > 0 && patch.patch_status === 'Applied') {
      const targetResolved = await isTargetBugResolvedInFile({
        absPath: path.join(tmpAfterDir, patch.file_path),
        relPath: patch.file_path,
        projectDir: tmpAfterDir,
        bugTitle: patch.bug_title,
        startLine: patch.start_line,
      });
      if (targetResolved) {
        db.prepare(`UPDATE bugs SET bug_status = 'Fixed' WHERE id = ?`).run(patch.bug_id);
      }
    }

    recordHistory({
      projectId: patch.project_id,
      bugId: patch.bug_id,
      patchId: patch.id,
      userId: req.user!.id,
      actionType: 'TESTS_EXECUTED',
      previousValue: `${beforeSuite.passed}/${beforeSuite.total_tests} passed`,
      newValue: `${afterSuite.passed}/${afterSuite.total_tests} passed`,
      description: `Executed sandboxed tests for patch #${patch.id}: ${afterSuite.passed}/${afterSuite.total_tests} passed (${afterSuite.execution_time}s).`,
    });

    createNotification(
      req.user!.id,
      `Validation ${validationStatus}: ${patch.bug_code}`,
      `${afterSuite.passed} of ${afterSuite.total_tests} tests passed after patch (${afterSuite.execution_time}s).`,
      validationStatus === 'Tests Passed' ? 'success' : 'error'
    );

    emitUserUpdate(req.user!.id, 'tests_executed', { projectId: patch.project_id, patchId: patch.id });
    res.json({
      validation_status: validationStatus,
      before: beforeSuite,
      after: afterSuite,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Test execution failed.';
    res.status(500).json({ error: msg });
  } finally {
    fs.rmSync(tmpBeforeDir, { recursive: true, force: true });
    fs.rmSync(tmpAfterDir, { recursive: true, force: true });
  }
});

apiRouter.get('/patches/:patchId/test-results', requireAuth, (req: AuthRequest, res) => {
  const patch = db
    .prepare(
      `SELECT pa.id, pa.validation_status FROM patches pa JOIN projects p ON pa.project_id = p.id WHERE pa.id = ? AND p.user_id = ?`
    )
    .get(Number(req.params.patchId), req.user!.id) as
    | { id: number; validation_status: string }
    | undefined;
  if (!patch) {
    res.status(404).json({ error: 'Patch not found.' });
    return;
  }

  const rows = db
    .prepare(`SELECT * FROM test_results WHERE patch_id = ? ORDER BY id ASC`)
    .all(patch.id) as Array<{
    phase: string;
    test_status: string;
    execution_time: number;
  }>;

  const before = rows.filter((r) => r.phase === 'before');
  const after = rows.filter((r) => r.phase === 'after');

  res.json({
    validation_status: patch.validation_status,
    before,
    after,
    summary: {
      total_tests: after.length,
      passed: after.filter((r) => r.test_status === 'Passed').length,
      failed: after.filter((r) => r.test_status === 'Failed').length,
      execution_time: Number(after.reduce((acc, r) => acc + (r.execution_time || 0), 0).toFixed(3)),
    },
  });
});

// ---------------------------------------------------------------------------
// 8. HISTORY, NOTIFICATIONS & REPORTS
// ---------------------------------------------------------------------------

apiRouter.get('/history', requireAuth, (req: AuthRequest, res) => {
  const history = db
    .prepare(
      `SELECT ch.*, p.project_name, b.bug_code, b.bug_title, pa.patch_status, pa.validation_status, pa.proposed_code, pa.original_code
       FROM change_history ch
       JOIN projects p ON ch.project_id = p.id
       LEFT JOIN bugs b ON ch.bug_id = b.id
       LEFT JOIN patches pa ON ch.patch_id = pa.id
       WHERE ch.user_id = ?
       ORDER BY ch.id DESC
       LIMIT 100`
    )
    .all(req.user!.id);
  res.json({ history });
});

apiRouter.get('/projects/:projectId/history', requireAuth, (req: AuthRequest, res) => {
  const history = db
    .prepare(
      `SELECT ch.*, p.project_name, b.bug_code, b.bug_title, pa.patch_status, pa.validation_status
       FROM change_history ch
       JOIN projects p ON ch.project_id = p.id
       LEFT JOIN bugs b ON ch.bug_id = b.id
       LEFT JOIN patches pa ON ch.patch_id = pa.id
       WHERE ch.project_id = ? AND ch.user_id = ?
       ORDER BY ch.id DESC`
    )
    .all(Number(req.params.projectId), req.user!.id);
  res.json({ history });
});

apiRouter.get('/notifications', requireAuth, (req: AuthRequest, res) => {
  const notifications = db
    .prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30`)
    .all(req.user!.id);
  res.json({ notifications });
});

apiRouter.patch('/notifications/:notificationId/read', requireAuth, (req: AuthRequest, res) => {
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`).run(
    Number(req.params.notificationId),
    req.user!.id
  );
  res.json({ ok: true });
});

apiRouter.post('/notifications/read-all', requireAuth, (req: AuthRequest, res) => {
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ?`).run(req.user!.id);
  res.json({ ok: true });
});

function buildProjectReport(projectId: number, userId: number) {
  const project = db
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(projectId, userId) as Record<string, unknown> | undefined;
  if (!project) return null;

  const bugs = db
    .prepare(`SELECT * FROM bugs WHERE project_id = ? ORDER BY id ASC`)
    .all(projectId) as Array<Record<string, unknown>>;
  const patches = db
    .prepare(`SELECT * FROM patches WHERE project_id = ? ORDER BY id DESC`)
    .all(projectId) as Array<Record<string, unknown>>;
  const tests = db
    .prepare(`SELECT * FROM test_results WHERE project_id = ? AND phase = 'after' ORDER BY id ASC`)
    .all(projectId) as Array<Record<string, unknown>>;

  const severityCounts: Record<string, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const b of bugs) {
    const sev = String(b.severity || 'Medium');
    severityCounts[sev] = (severityCounts[sev] || 0) + 1;
  }

  return {
    generated_at: new Date().toISOString(),
    project,
    summary: {
      total_bugs: bugs.length,
      bugs_fixed: bugs.filter((b) => b.bug_status === 'Fixed').length,
      patches_generated: patches.length,
      patches_approved_or_applied: patches.filter((p) =>
        ['Approved', 'Applied'].includes(String(p.patch_status))
      ).length,
      tests_total: tests.length,
      tests_passed: tests.filter((t) => t.test_status === 'Passed').length,
      severity_distribution: severityCounts,
    },
    bugs,
    patches,
    test_results: tests,
  };
}

apiRouter.get('/projects/:projectId/report', requireAuth, (req: AuthRequest, res) => {
  const report = buildProjectReport(Number(req.params.projectId), req.user!.id);
  if (!report) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  res.json({ report });
});

apiRouter.get('/projects/:projectId/report/download', requireAuth, (req: AuthRequest, res) => {
  const report = buildProjectReport(Number(req.params.projectId), req.user!.id);
  if (!report) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  const format = String(req.query.format || 'markdown').toLowerCase();
  const safeName = String((report.project as { project_name: string }).project_name).replace(
    /[^a-zA-Z0-9_-]/g,
    '_'
  );

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="autopatch_report_${safeName}.json"`);
    res.send(JSON.stringify(report, null, 2));
    return;
  }

  const lines: string[] = [
    `# AutoPatch Repair & Validation Report`,
    ``,
    `- **Project**: ${(report.project as { project_name: string }).project_name}`,
    `- **Language**: ${(report.project as { programming_language: string }).programming_language}`,
    `- **Generated**: ${report.generated_at}`,
    `- **Total Bugs Detected**: ${report.summary.total_bugs}`,
    `- **Bugs Fixed**: ${report.summary.bugs_fixed}`,
    `- **Validation Tests**: ${report.summary.tests_passed}/${report.summary.tests_total} passed`,
    ``,
    `## Severity Distribution`,
    ...Object.entries(report.summary.severity_distribution).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Detected Bugs & Root Causes`,
  ];

  for (const b of report.bugs) {
    lines.push(
      `### ${b.bug_code}: ${b.bug_title} (${b.severity} · ${b.bug_status})`,
      `- **Location**: \`${b.file_path}\` lines ${b.start_line}-${b.end_line}`,
      `- **Root Cause**: ${b.root_cause || b.bug_description}`,
      `- **Recommended Solution**: ${b.suggested_solution || 'N/A'}`,
      ``
    );
  }

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="autopatch_report_${safeName}.md"`);
  res.send(lines.join('\n'));
});
