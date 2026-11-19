import {
  apiRequest,
  API_BASE,
  getAccessToken,
  isBackendUnreachableError,
  uploadWithProgress,
} from './api.ts';
import { firestoreStore, getFirebaseUid } from './firestoreStore.ts';
import type {
  Bug,
  ChangeHistoryItem,
  DashboardSummary,
  NotificationItem,
  Patch,
  Project,
  ProjectDiagnostics,
  ProjectFile,
  ScanJob,
  TestResult,
  User,
} from '../types/autopatch.ts';

function shouldUseCloudOnlyFallback(err: unknown): boolean {
  return Boolean(getFirebaseUid()) && (!getAccessToken() || isBackendUnreachableError(err));
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.message.toLowerCase().includes('not found');
}

async function mirrorProjectBundleToCloud(uid: string, projectId: number) {
  try {
    const [projRes, diagRes, bugRes] = await Promise.all([
      apiRequest<{ project: Project; latest_scan: ScanJob | null }>(`/projects/${projectId}`),
      apiRequest<{ diagnostics: ProjectDiagnostics }>(`/projects/${projectId}/diagnostics`),
      apiRequest<{ bugs: Bug[] }>(`/projects/${projectId}/bugs`),
    ]);

    const files = (diagRes.diagnostics?.files || []).map((f) => ({
      file_name: f.file_name,
      file_path: f.file_path,
      file_extension: f.file_name.includes('.') ? `.${f.file_name.split('.').pop()}` : '',
      file_size: f.file_size,
      programming_language: f.programming_language,
      content: f.content,
    }));

    await firestoreStore.syncProjectSnapshot(uid, projRes.project, {
      files,
      scan: projRes.latest_scan,
      bugs: bugRes.bugs,
    });
  } catch {
    // Non-fatal background cloud sync
  }
}

export const authService = {
  register(payload: { full_name: string; email: string; password: string }) {
    return apiRequest<{ access_token: string; refresh_token: string; user: User }>(
      '/auth/register',
      { method: 'POST', body: JSON.stringify(payload) }
    );
  },
  login(payload: { email: string; password: string }) {
    return apiRequest<{ access_token: string; refresh_token: string; user: User }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify(payload) }
    );
  },
  firebaseLogin(idToken: string) {
    return apiRequest<{ access_token: string; refresh_token: string; user: User }>(
      '/auth/firebase',
      { method: 'POST', body: JSON.stringify({ id_token: idToken }) }
    );
  },
  logout(refreshToken: string | null) {
    return apiRequest<{ message: string }>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  },
  me() {
    return apiRequest<{ user: User }>('/auth/me');
  },
  async updateProfile(
    payload: Partial<{
      full_name: string;
      preferred_language: string;
      notify_scan_complete: boolean;
      notify_critical_bugs: boolean;
      notify_patch_tests: boolean;
      theme_mode: string;
    }>
  ) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const user = await firestoreStore.updateUserProfile(uid, payload);
      return { user };
    }
    try {
      const res = await apiRequest<{ user: User }>('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      if (uid) {
        await firestoreStore.updateUserProfile(uid, payload);
      }
      return res;
    } catch (err) {
      if (uid && shouldUseCloudOnlyFallback(err)) {
        const user = await firestoreStore.updateUserProfile(uid, payload);
        return { user };
      }
      throw err;
    }
  },
  changePassword(payload: { current_password: string; new_password: string }) {
    return apiRequest<{ message: string }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};

export const projectService = {
  async dashboard(projectId?: number): Promise<DashboardSummary> {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      return firestoreStore.buildDashboardFromFirestore(uid, projectId);
    }
    const q = projectId ? `?projectId=${projectId}` : '';
    try {
      const res = await apiRequest<DashboardSummary>(`/dashboard/summary${q}`);
      if (uid && res.recent_projects.length === 0) {
        const cloudSummary = await firestoreStore.buildDashboardFromFirestore(uid, projectId);
        if (cloudSummary.stats.total_projects > 0) return cloudSummary;
      }
      if (uid && res.active_diagnostics?.project.id) {
        void mirrorProjectBundleToCloud(uid, res.active_diagnostics.project.id);
      }
      return res;
    } catch (err) {
      if (uid && shouldUseCloudOnlyFallback(err)) {
        return firestoreStore.buildDashboardFromFirestore(uid, projectId);
      }
      throw err;
    }
  },
  async diagnostics(projectId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const diag = await firestoreStore.buildDiagnosticsFromFirestore(uid, projectId);
      if (!diag) throw new Error('Project not found.');
      return { diagnostics: diag };
    }
    try {
      const res = await apiRequest<{ diagnostics: ProjectDiagnostics }>(
        `/projects/${projectId}/diagnostics`
      );
      if (uid) {
        void mirrorProjectBundleToCloud(uid, projectId);
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const diag = await firestoreStore.buildDiagnosticsFromFirestore(uid, projectId);
        if (diag) return { diagnostics: diag };
      }
      throw err;
    }
  },
  streamUrl(projectId?: number) {
    const token = getAccessToken() || '';
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (projectId) params.set('projectId', String(projectId));
    return `${API_BASE}/dashboard/stream?${params.toString()}`;
  },
  async list() {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const projects = await firestoreStore.listProjects(uid);
      return { projects };
    }
    try {
      const res = await apiRequest<{ projects: Project[] }>('/projects');
      if (uid) {
        const cloudProjects = await firestoreStore.listProjects(uid);
        const backendIds = new Set(res.projects.map((p) => p.id));
        const merged = [...res.projects];
        for (const cp of cloudProjects) {
          if (!backendIds.has(cp.id)) merged.push(cp);
        }
        return { projects: merged };
      }
      return res;
    } catch (err) {
      if (uid && shouldUseCloudOnlyFallback(err)) {
        const projects = await firestoreStore.listProjects(uid);
        return { projects };
      }
      throw err;
    }
  },
  async get(projectId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const bundle = await firestoreStore.getProjectBundle(uid, projectId);
      if (!bundle) throw new Error('Project not found.');
      return { project: bundle.project, latest_scan: bundle.scans[0] || null };
    }
    try {
      return await apiRequest<{ project: Project; latest_scan: ScanJob | null }>(
        `/projects/${projectId}`
      );
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const bundle = await firestoreStore.getProjectBundle(uid, projectId);
        if (bundle) return { project: bundle.project, latest_scan: bundle.scans[0] || null };
      }
      throw err;
    }
  },
  async files(projectId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const bundle = await firestoreStore.getProjectBundle(uid, projectId);
      return { files: (bundle?.files || []) as ProjectFile[] };
    }
    try {
      return await apiRequest<{ files: ProjectFile[] }>(`/projects/${projectId}/files`);
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const bundle = await firestoreStore.getProjectBundle(uid, projectId);
        if (bundle) return { files: bundle.files as ProjectFile[] };
      }
      throw err;
    }
  },
  async uploadZip(formData: FormData, onProgress: (pct: number) => void) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const file = formData.get('file') as File | null;
      if (!file) throw new Error('Please choose a file to upload.');
      onProgress(60);
      const project = await firestoreStore.uploadFileCloud(
        uid,
        file,
        String(formData.get('project_name') || file.name),
        String(formData.get('description') || ''),
        String(formData.get('programming_language') || 'Python')
      );
      onProgress(100);
      return { project, files_count: project.file_count || 1 };
    }
    try {
      const res = await uploadWithProgress<{ project: Project; files_count: number }>(
        '/projects/upload',
        formData,
        onProgress
      );
      if (uid) {
        await mirrorProjectBundleToCloud(uid, res.project.id);
      }
      return res;
    } catch (err) {
      const file = formData.get('file') as File | null;
      if (uid && file && shouldUseCloudOnlyFallback(err)) {
        onProgress(70);
        const project = await firestoreStore.uploadFileCloud(
          uid,
          file,
          String(formData.get('project_name') || file.name),
          String(formData.get('description') || ''),
          String(formData.get('programming_language') || 'Python')
        );
        onProgress(100);
        return { project, files_count: project.file_count || 1 };
      }
      throw err;
    }
  },
  async importGithub(payload: {
    repository_url: string;
    branch: string;
    project_name: string;
    description: string;
    programming_language: string;
  }) {
    const res = await apiRequest<{ project: Project; files_count: number }>('/projects/github', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const uid = getFirebaseUid();
    if (uid) {
      await mirrorProjectBundleToCloud(uid, res.project.id);
    }
    return res;
  },
  async createSample(projectName?: string) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const project = await firestoreStore.createSampleProjectCloud(uid, projectName);
      return { project, files_count: project.file_count || 3 };
    }
    try {
      const res = await apiRequest<{ project: Project; files_count: number }>('/projects/sample', {
        method: 'POST',
        body: JSON.stringify({ project_name: projectName }),
      });
      if (uid) {
        await mirrorProjectBundleToCloud(uid, res.project.id);
      }
      return res;
    } catch (err) {
      if (uid && shouldUseCloudOnlyFallback(err)) {
        const project = await firestoreStore.createSampleProjectCloud(uid, projectName);
        return { project, files_count: project.file_count || 3 };
      }
      throw err;
    }
  },
  async delete(projectId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      await firestoreStore.deleteProject(uid, projectId);
      return { message: 'Project deleted.' };
    }
    try {
      const res = await apiRequest<{ message: string }>(`/projects/${projectId}`, {
        method: 'DELETE',
      });
      if (uid) {
        void firestoreStore.deleteProject(uid, projectId).catch(() => {});
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        await firestoreStore.deleteProject(uid, projectId);
        return { message: 'Project deleted.' };
      }
      throw err;
    }
  },
  async startScan(projectId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const scan = await firestoreStore.runCloudScan(uid, projectId);
      return { scan };
    }
    try {
      const res = await apiRequest<{ scan: ScanJob }>(`/projects/${projectId}/scan`, {
        method: 'POST',
      });
      if (uid) {
        void firestoreStore.syncScan(uid, projectId, res.scan).catch(() => {});
        setTimeout(() => {
          void mirrorProjectBundleToCloud(uid, projectId);
        }, 2500);
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const scan = await firestoreStore.runCloudScan(uid, projectId);
        return { scan };
      }
      throw err;
    }
  },
  async getScan(scanId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const projects = await firestoreStore.listProjects(uid);
      for (const p of projects) {
        const b = await firestoreStore.getProjectBundle(uid, p.id);
        const found = b?.scans.find((s) => s.id === scanId);
        if (found) return { scan: found };
      }
      throw new Error('Scan job not found.');
    }
    try {
      const res = await apiRequest<{ scan: ScanJob }>(`/scans/${scanId}`);
      if (uid && res.scan) {
        void firestoreStore.syncScan(uid, res.scan.project_id, res.scan).catch(() => {});
        if (res.scan.scan_status === 'Completed') {
          void mirrorProjectBundleToCloud(uid, res.scan.project_id);
        }
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const projects = await firestoreStore.listProjects(uid);
        for (const p of projects) {
          const b = await firestoreStore.getProjectBundle(uid, p.id);
          const found = b?.scans.find((s) => s.id === scanId);
          if (found) return { scan: found };
        }
      }
      throw err;
    }
  },
};

export const bugService = {
  async listAll() {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const projects = await firestoreStore.listProjects(uid);
      const bundles = await Promise.all(projects.map((p) => firestoreStore.getProjectBundle(uid, p.id)));
      return { bugs: bundles.flatMap((b) => b?.bugs || []) };
    }
    try {
      const res = await apiRequest<{ bugs: Bug[] }>('/bugs');
      if (uid && res.bugs.length === 0) {
        const projects = await firestoreStore.listProjects(uid);
        const bundles = await Promise.all(
          projects.map((p) => firestoreStore.getProjectBundle(uid, p.id))
        );
        const cloudBugs = bundles.flatMap((b) => b?.bugs || []);
        if (cloudBugs.length > 0) return { bugs: cloudBugs };
      }
      return res;
    } catch (err) {
      if (uid && shouldUseCloudOnlyFallback(err)) {
        const projects = await firestoreStore.listProjects(uid);
        const bundles = await Promise.all(
          projects.map((p) => firestoreStore.getProjectBundle(uid, p.id))
        );
        return { bugs: bundles.flatMap((b) => b?.bugs || []) };
      }
      throw err;
    }
  },
  async listByProject(projectId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const bundle = await firestoreStore.getProjectBundle(uid, projectId);
      return { bugs: bundle?.bugs || [] };
    }
    try {
      return await apiRequest<{ bugs: Bug[] }>(`/projects/${projectId}/bugs`);
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const bundle = await firestoreStore.getProjectBundle(uid, projectId);
        if (bundle) return { bugs: bundle.bugs };
      }
      throw err;
    }
  },
  async get(bugId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const projects = await firestoreStore.listProjects(uid);
      for (const p of projects) {
        const bundle = await firestoreStore.getProjectBundle(uid, p.id);
        const bug = bundle?.bugs.find((b) => b.id === bugId);
        if (bug && bundle) {
          const file = bundle.files.find((f) => f.file_path === bug.file_path);
          const patches = bundle.patches.filter((pa) => pa.bug_id === bug.id);
          return { bug, file_content: file?.content || bug.original_code, patches };
        }
      }
      throw new Error('Bug record not found.');
    }
    try {
      return await apiRequest<{ bug: Bug; file_content: string; patches: Patch[] }>(
        `/bugs/${bugId}`
      );
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const projects = await firestoreStore.listProjects(uid);
        for (const p of projects) {
          const bundle = await firestoreStore.getProjectBundle(uid, p.id);
          const bug = bundle?.bugs.find((b) => b.id === bugId);
          if (bug && bundle) {
            const file = bundle.files.find((f) => f.file_path === bug.file_path);
            const patches = bundle.patches.filter((pa) => pa.bug_id === bug.id);
            return { bug, file_content: file?.content || bug.original_code, patches };
          }
        }
      }
      throw err;
    }
  },
  async updateStatus(bugId: number, bugStatus: Bug['bug_status']) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const bug = await firestoreStore.updateBugStatusCloud(uid, bugId, bugStatus);
      return { bug };
    }
    try {
      const res = await apiRequest<{ bug: Bug }>(`/bugs/${bugId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ bug_status: bugStatus }),
      });
      if (uid && res.bug) {
        void firestoreStore.syncBug(uid, res.bug).catch(() => {});
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const bug = await firestoreStore.updateBugStatusCloud(uid, bugId, bugStatus);
        return { bug };
      }
      throw err;
    }
  },
  async analyzeWithAI(bugId: number) {
    const uid = getFirebaseUid();
    try {
      const res = await apiRequest<{ bug: Bug }>(`/bugs/${bugId}/analyze`, { method: 'POST' });
      if (uid && res.bug) {
        void firestoreStore.syncBug(uid, res.bug).catch(() => {});
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const existing = await this.get(bugId);
        return { bug: existing.bug };
      }
      throw err;
    }
  },
};

export const patchService = {
  async listAll() {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const projects = await firestoreStore.listProjects(uid);
      const bundles = await Promise.all(projects.map((p) => firestoreStore.getProjectBundle(uid, p.id)));
      return { patches: bundles.flatMap((b) => b?.patches || []) };
    }
    try {
      const res = await apiRequest<{ patches: Patch[] }>('/patches');
      if (uid && res.patches.length === 0) {
        const projects = await firestoreStore.listProjects(uid);
        const bundles = await Promise.all(
          projects.map((p) => firestoreStore.getProjectBundle(uid, p.id))
        );
        const cloudPatches = bundles.flatMap((b) => b?.patches || []);
        if (cloudPatches.length > 0) return { patches: cloudPatches };
      }
      return res;
    } catch (err) {
      if (uid && shouldUseCloudOnlyFallback(err)) {
        const projects = await firestoreStore.listProjects(uid);
        const bundles = await Promise.all(
          projects.map((p) => firestoreStore.getProjectBundle(uid, p.id))
        );
        return { patches: bundles.flatMap((b) => b?.patches || []) };
      }
      throw err;
    }
  },
  async get(patchId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const projects = await firestoreStore.listProjects(uid);
      for (const p of projects) {
        const b = await firestoreStore.getProjectBundle(uid, p.id);
        const found = b?.patches.find((pa) => pa.id === patchId);
        if (found) return { patch: found };
      }
      throw new Error('Patch not found.');
    }
    try {
      return await apiRequest<{ patch: Patch }>(`/patches/${patchId}`);
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const projects = await firestoreStore.listProjects(uid);
        for (const p of projects) {
          const b = await firestoreStore.getProjectBundle(uid, p.id);
          const found = b?.patches.find((pa) => pa.id === patchId);
          if (found) return { patch: found };
        }
      }
      throw err;
    }
  },
  async generate(bugId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const patch = await firestoreStore.generatePatchCloud(uid, bugId);
      return { patch };
    }
    try {
      const res = await apiRequest<{ patch: Patch }>(`/bugs/${bugId}/patches`, { method: 'POST' });
      if (uid && res.patch) {
        void firestoreStore.syncPatch(uid, res.patch).catch(() => {});
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const patch = await firestoreStore.generatePatchCloud(uid, bugId);
        return { patch };
      }
      throw err;
    }
  },
  async approve(patchId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const patch = await firestoreStore.transitionPatchCloud(uid, patchId, 'approve');
      return { patch };
    }
    try {
      const res = await apiRequest<{ patch: Patch }>(`/patches/${patchId}/approve`, {
        method: 'POST',
      });
      if (uid && res.patch) {
        void firestoreStore.syncPatch(uid, res.patch).catch(() => {});
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const patch = await firestoreStore.transitionPatchCloud(uid, patchId, 'approve');
        return { patch };
      }
      throw err;
    }
  },
  async reject(patchId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const patch = await firestoreStore.transitionPatchCloud(uid, patchId, 'reject');
      return { patch };
    }
    try {
      const res = await apiRequest<{ patch: Patch }>(`/patches/${patchId}/reject`, {
        method: 'POST',
      });
      if (uid && res.patch) {
        void firestoreStore.syncPatch(uid, res.patch).catch(() => {});
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const patch = await firestoreStore.transitionPatchCloud(uid, patchId, 'reject');
        return { patch };
      }
      throw err;
    }
  },
  async apply(patchId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const patch = await firestoreStore.transitionPatchCloud(uid, patchId, 'apply');
      return { patch };
    }
    try {
      const res = await apiRequest<{ patch: Patch }>(`/patches/${patchId}/apply`, { method: 'POST' });
      if (uid && res.patch) {
        void firestoreStore.syncPatch(uid, res.patch).catch(() => {});
        void mirrorProjectBundleToCloud(uid, res.patch.project_id);
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const patch = await firestoreStore.transitionPatchCloud(uid, patchId, 'apply');
        return { patch };
      }
      throw err;
    }
  },
  async rollback(patchId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const patch = await firestoreStore.transitionPatchCloud(uid, patchId, 'rollback');
      return { patch };
    }
    try {
      const res = await apiRequest<{ patch: Patch }>(`/patches/${patchId}/rollback`, {
        method: 'POST',
      });
      if (uid && res.patch) {
        void firestoreStore.syncPatch(uid, res.patch).catch(() => {});
        void mirrorProjectBundleToCloud(uid, res.patch.project_id);
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        const patch = await firestoreStore.transitionPatchCloud(uid, patchId, 'rollback');
        return { patch };
      }
      throw err;
    }
  },
};

export const testService = {
  async run(patchId: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      return firestoreStore.runTestsCloud(uid, patchId);
    }
    try {
      const res = await apiRequest<{
        validation_status: string;
        before: {
          total_tests: number;
          passed: number;
          failed: number;
          execution_time: number;
          results: TestResult[];
        };
        after: {
          total_tests: number;
          passed: number;
          failed: number;
          execution_time: number;
          results: TestResult[];
        };
      }>(`/patches/${patchId}/test`, { method: 'POST' });

      if (uid) {
        try {
          const patchRes = await patchService.get(patchId);
          await firestoreStore.syncPatch(uid, patchRes.patch);
          await firestoreStore.syncTestResults(
            uid,
            patchRes.patch.project_id,
            patchId,
            res.before.results,
            res.after.results
          );
          void mirrorProjectBundleToCloud(uid, patchRes.patch.project_id);
        } catch {
          // Non-fatal cloud sync
        }
      }
      return res;
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        return firestoreStore.runTestsCloud(uid, patchId);
      }
      throw err;
    }
  },
  async getResults(patchId: number) {
    const uid = getFirebaseUid();
    const getCloudResults = async () => {
      if (!uid) throw new Error('Patch not found.');
      const projects = await firestoreStore.listProjects(uid);
      for (const p of projects) {
        const b = await firestoreStore.getProjectBundle(uid, p.id);
        const patch = b?.patches.find((pa) => pa.id === patchId);
        if (patch && b) {
          const all = b.testResults.filter((t) => t.patch_id === patchId);
          const before = all.filter((t) => t.phase === 'before');
          const after = all.filter((t) => t.phase === 'after');
          return {
            validation_status: patch.validation_status,
            before,
            after,
            summary: {
              total_tests: after.length,
              passed: after.filter((t) => t.test_status === 'Passed').length,
              failed: after.filter((t) => t.test_status === 'Failed').length,
              execution_time: Number(
                after.reduce((acc, r) => acc + (r.execution_time || 0), 0).toFixed(3)
              ),
            },
          };
        }
      }
      throw new Error('Patch not found.');
    };

    if (uid && !getAccessToken()) {
      return getCloudResults();
    }
    try {
      return await apiRequest<{
        validation_status: string;
        before: TestResult[];
        after: TestResult[];
        summary: { total_tests: number; passed: number; failed: number; execution_time: number };
      }>(`/patches/${patchId}/test-results`);
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        return getCloudResults();
      }
      throw err;
    }
  },
};

export const reportService = {
  async history() {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const projects = await firestoreStore.listProjects(uid);
      const bundles = await Promise.all(projects.map((p) => firestoreStore.getProjectBundle(uid, p.id)));
      const history = bundles
        .flatMap((b) => b?.history || [])
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { history };
    }
    try {
      const res = await apiRequest<{ history: ChangeHistoryItem[] }>('/history');
      if (uid && res.history.length > 0) {
        void firestoreStore.syncHistory(uid, res.history.slice(0, 40));
      }
      return res;
    } catch (err) {
      if (uid && shouldUseCloudOnlyFallback(err)) {
        const projects = await firestoreStore.listProjects(uid);
        const bundles = await Promise.all(
          projects.map((p) => firestoreStore.getProjectBundle(uid, p.id))
        );
        const history = bundles
          .flatMap((b) => b?.history || [])
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        return { history };
      }
      throw err;
    }
  },
  async notifications() {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      const notifications = await firestoreStore.listNotifications(uid);
      return { notifications };
    }
    try {
      const res = await apiRequest<{ notifications: NotificationItem[] }>('/notifications');
      if (uid && res.notifications.length === 0) {
        const cloudNotifs = await firestoreStore.listNotifications(uid);
        if (cloudNotifs.length > 0) return { notifications: cloudNotifs };
      }
      return res;
    } catch (err) {
      if (uid && shouldUseCloudOnlyFallback(err)) {
        const notifications = await firestoreStore.listNotifications(uid);
        return { notifications };
      }
      throw err;
    }
  },
  async markNotificationRead(id: number) {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      await firestoreStore.markNotificationRead(uid, id);
      return { ok: true };
    }
    try {
      const res = await apiRequest<{ ok: boolean }>(`/notifications/${id}/read`, {
        method: 'PATCH',
      });
      if (uid) void firestoreStore.markNotificationRead(uid, id);
      return res;
    } catch (err) {
      if (uid && shouldUseCloudOnlyFallback(err)) {
        await firestoreStore.markNotificationRead(uid, id);
        return { ok: true };
      }
      throw err;
    }
  },
  async markAllRead() {
    const uid = getFirebaseUid();
    if (uid && !getAccessToken()) {
      await firestoreStore.markAllNotificationsRead(uid);
      return { ok: true };
    }
    try {
      const res = await apiRequest<{ ok: boolean }>('/notifications/read-all', { method: 'POST' });
      if (uid) void firestoreStore.markAllNotificationsRead(uid);
      return res;
    } catch (err) {
      if (uid && shouldUseCloudOnlyFallback(err)) {
        await firestoreStore.markAllNotificationsRead(uid);
        return { ok: true };
      }
      throw err;
    }
  },
  async getReport(projectId: number) {
    const uid = getFirebaseUid();
    const buildCloudReport = async () => {
      if (!uid) throw new Error('Project not found.');
      const b = await firestoreStore.getProjectBundle(uid, projectId);
      if (!b) throw new Error('Project not found.');
      const severityDistribution: Record<string, number> = {
        Critical: 0,
        High: 0,
        Medium: 0,
        Low: 0,
      };
      for (const bug of b.bugs) {
        severityDistribution[bug.severity] = (severityDistribution[bug.severity] || 0) + 1;
      }
      const afterTests = b.testResults.filter((t) => t.phase === 'after');
      return {
        report: {
          generated_at: new Date().toISOString(),
          project: b.project,
          summary: {
            total_bugs: b.bugs.length,
            bugs_fixed: b.bugs.filter((bg) => bg.bug_status === 'Fixed').length,
            patches_generated: b.patches.length,
            patches_approved_or_applied: b.patches.filter((pa) =>
              ['Approved', 'Applied'].includes(pa.patch_status)
            ).length,
            tests_total: afterTests.length,
            tests_passed: afterTests.filter((t) => t.test_status === 'Passed').length,
            severity_distribution: severityDistribution,
          },
          bugs: b.bugs,
          patches: b.patches,
          test_results: afterTests,
        },
      };
    };

    if (uid && !getAccessToken()) {
      return buildCloudReport();
    }
    try {
      return await apiRequest<{
        report: {
          generated_at: string;
          project: Project;
          summary: {
            total_bugs: number;
            bugs_fixed: number;
            patches_generated: number;
            patches_approved_or_applied: number;
            tests_total: number;
            tests_passed: number;
            severity_distribution: Record<string, number>;
          };
          bugs: Bug[];
          patches: Patch[];
          test_results: TestResult[];
        };
      }>(`/projects/${projectId}/report`);
    } catch (err) {
      if (uid && (shouldUseCloudOnlyFallback(err) || isNotFoundError(err))) {
        return buildCloudReport();
      }
      throw err;
    }
  },
  async downloadReport(projectId: number, format: 'markdown' | 'json') {
    const token = getAccessToken();
    try {
      const res = await fetch(
        `${API_BASE}/projects/${projectId}/report/download?format=${format}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `autopatch_report_${projectId}.${format === 'json' ? 'json' : 'md'}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return;
      }
    } catch {
      // Fallback to client-side report export below
    }

    const { report } = await this.getReport(projectId);
    const content =
      format === 'json'
        ? JSON.stringify(report, null, 2)
        : [
            `# AutoPatch Repair & Validation Report`,
            ``,
            `- **Project**: ${report.project.project_name}`,
            `- **Language**: ${report.project.programming_language}`,
            `- **Generated**: ${report.generated_at}`,
            `- **Total Bugs**: ${report.summary.total_bugs}`,
            `- **Bugs Fixed**: ${report.summary.bugs_fixed}`,
            ``,
            ...report.bugs.map(
              (b) =>
                `### ${b.bug_code}: ${b.bug_title} (${b.severity} · ${b.bug_status})\n- **Location**: \`${b.file_path}\` lines ${b.start_line}-${b.end_line}\n- **Root Cause**: ${b.root_cause || b.bug_description}\n`
            ),
          ].join('\n');

    const blob = new Blob([content], {
      type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `autopatch_report_${projectId}.${format === 'json' ? 'json' : 'md'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
