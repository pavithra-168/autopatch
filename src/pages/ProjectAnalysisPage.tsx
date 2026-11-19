import { ArrowRight, Check, CheckCircle2, Clock, Loader2, Play, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LiveCodeInspector } from '../components/LiveCodeInspector.tsx';
import { StatusText } from '../components/StatusLabel.tsx';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { getAccessToken } from '../services/api.ts';
import { projectService } from '../services/domainServices.ts';
import type { DashboardSummary, Project, ProjectDiagnostics, ProjectFile, ScanJob } from '../types/autopatch.ts';

const STAGES = [
  'Project Structure Analysis',
  'Dependency Analysis',
  'Code Scanning',
  'Bug Detection',
  'Analysis Completed',
];

export function ProjectAnalysisPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(
    searchParams.get('projectId') ? Number(searchParams.get('projectId')) : null
  );
  const [scan, setScan] = useState<ScanJob | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [diagnostics, setDiagnostics] = useState<ProjectDiagnostics | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadDiagnostics = useCallback(async (pid: number) => {
    try {
      const res = await projectService.diagnostics(pid);
      setDiagnostics(res.diagnostics);
    } catch {
      // ignore transient errors
    }
  }, []);

  const projectIdParam = searchParams.get('projectId');

  useEffect(() => {
    if (projectIdParam) {
      const parsed = Number(projectIdParam);
      if (Number.isFinite(parsed) && parsed > 0) {
        setSelectedProjectId((prev) => (prev === parsed ? prev : parsed));
      }
    }
  }, [projectIdParam]);

  useEffect(() => {
    projectService
      .list()
      .then((res) => {
        setProjects(res.projects);
        const initialPid =
          selectedProjectId || (res.projects[0] ? res.projects[0].id : null);
        if (initialPid) {
          setSelectedProjectId(initialPid);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load projects.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const scanIdParam = searchParams.get('scanId');
    if (scanIdParam) {
      projectService
        .getScan(Number(scanIdParam))
        .then((res) => setScan(res.scan))
        .catch(() => {});
    } else if (selectedProjectId) {
      projectService
        .get(selectedProjectId)
        .then((res) => setScan(res.latest_scan))
        .catch(() => {});
    }
    if (selectedProjectId) {
      projectService
        .files(selectedProjectId)
        .then((res) => setFiles(res.files))
        .catch(() => {});
      loadDiagnostics(selectedProjectId);
    }
  }, [selectedProjectId, searchParams, loadDiagnostics]);

  // Polling fallback while scan is Running or Pending (in case SSE drops or in Cloud mode)
  const scanId = scan?.id ?? null;
  const scanStatus = scan?.scan_status ?? null;
  useEffect(() => {
    if (!scanId || (scanStatus !== 'Running' && scanStatus !== 'Pending')) return;
    const timer = window.setInterval(() => {
      projectService
        .getScan(scanId)
        .then((res) => {
          setScan(res.scan);
          if (
            (res.scan.scan_status === 'Completed' || res.scan.scan_status === 'Failed') &&
            selectedProjectId
          ) {
            loadDiagnostics(selectedProjectId);
            projectService
              .files(selectedProjectId)
              .then((fRes) => setFiles(fRes.files))
              .catch(() => {});
          }
        })
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [scanId, scanStatus, selectedProjectId, loadDiagnostics]);

  // Real-time SSE subscription for live scan stages + per-file Red/Green updates
  useEffect(() => {
    const token = getAccessToken();
    if (!token || !selectedProjectId) return;

    const es = new EventSource(projectService.streamUrl(selectedProjectId));
    es.onopen = () => setSseConnected(true);
    es.addEventListener('snapshot', (evt) => {
      try {
        const payload = JSON.parse((evt as MessageEvent).data) as DashboardSummary;
        setSseConnected(true);
        if (payload.server_time) setLastSyncedAt(payload.server_time);
        if (payload.active_diagnostics && payload.active_diagnostics.project.id === selectedProjectId) {
          setDiagnostics(payload.active_diagnostics);
          if (payload.active_diagnostics.latest_scan) {
            setScan((prev) =>
              prev && prev.id > payload.active_diagnostics!.latest_scan!.id
                ? prev
                : payload.active_diagnostics!.latest_scan
            );
          }
        }
      } catch {
        // ignore parse errors
      }
    });
    es.onerror = () => setSseConnected(false);

    return () => {
      es.close();
      setSseConnected(false);
    };
  }, [selectedProjectId]);

  const handleTriggerScan = async () => {
    if (!selectedProjectId) return;
    setError('');
    try {
      const res = await projectService.startScan(selectedProjectId);
      setScan(res.scan);
      setSearchParams({ projectId: String(selectedProjectId), scanId: String(res.scan.id) });
      loadDiagnostics(selectedProjectId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to start scan.');
    }
  };

  const activeStageIndex = scan ? STAGES.indexOf(scan.current_stage) : -1;
  const diagFilesByPath = new Map((diagnostics?.files ?? []).map((f) => [f.file_path, f]));

  return (
    <DashboardLayout
      title="Project Analysis"
      breadcrumb="Projects / Live Pipeline & Line Inspector"
      action={
        selectedProjectId ? (
          <button
            type="button"
            onClick={handleTriggerScan}
            className="px-4 py-2 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Run Live Scan</span>
          </button>
        ) : null
      }
    >
      {loading ? (
        <div className="p-8 text-sm text-slate-400">Loading analysis pipeline...</div>
      ) : projects.length === 0 ? (
        <div className="p-8 rounded-xl bg-[#111C2D] border border-slate-800 text-center">
          <p className="text-sm text-slate-300">No projects found. Upload a project first.</p>
          <Link
            to="/upload"
            className="mt-4 inline-flex px-4 py-2 text-xs font-semibold bg-[#3B82F6] text-white rounded-lg"
          >
            Go to Upload Project
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="p-5 rounded-xl bg-[#111C2D] border border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <label className="text-xs font-medium text-slate-400">Project:</label>
              <select
                value={selectedProjectId ?? ''}
                onChange={(e) => {
                  const nextId = Number(e.target.value);
                  setSelectedProjectId(nextId);
                  setSearchParams({ projectId: String(nextId) });
                }}
                className="px-3.5 py-2 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.project_name} ({p.programming_language})
                  </option>
                ))}
              </select>
            </div>
            {scan && <StatusText status={scan.scan_status} />}
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              {error}
            </div>
          )}

          {scan ? (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7 p-6 rounded-xl bg-[#111C2D] border border-slate-800 space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="text-xs text-slate-400">Active Job #{scan.id}</p>
                    <h2 className="text-lg font-display font-bold text-white mt-0.5">
                      {scan.project_name || diagnostics?.project.project_name || 'Project Scan'}
                    </h2>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-display font-bold text-[#3B82F6] font-mono tabular-nums">
                      {scan.progress_percentage}%
                    </p>
                    <p className="text-xs text-slate-400 font-mono tabular-nums">
                      {scan.scanned_files} / {scan.total_files} files · {scan.total_bugs} issues
                    </p>
                  </div>
                </div>

                <div className="h-2 rounded bg-[#080F1D] border border-slate-800 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      scan.scan_status === 'Failed'
                        ? 'bg-red-500'
                        : scan.scan_status === 'Completed'
                        ? 'bg-emerald-500'
                        : 'bg-[#3B82F6]'
                    }`}
                    style={{ width: `${scan.progress_percentage}%` }}
                  />
                </div>

                <div className="space-y-2.5">
                  {STAGES.map((stage, idx) => {
                    const isDone =
                      scan.scan_status === 'Completed' || (activeStageIndex > idx && activeStageIndex !== -1);
                    const isCurrent =
                      scan.scan_status !== 'Completed' && scan.current_stage === stage;
                    return (
                      <div
                        key={stage}
                        className={`flex items-center justify-between px-4 py-3 rounded-lg border ${
                          isCurrent
                            ? 'bg-[#3B82F6]/10 border-[#3B82F6]/40 text-white'
                            : isDone
                            ? 'bg-[#080F1D]/70 border-slate-800 text-slate-200'
                            : 'bg-[#080F1D]/30 border-slate-800/50 text-slate-500'
                        }`}
                      >
                        <div className="flex items-center gap-3 text-sm">
                          {scan.scan_status === 'Failed' && isCurrent ? (
                            <XCircle className="w-4 h-4 text-red-400" />
                          ) : isDone ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          ) : isCurrent ? (
                            <Loader2 className="w-4 h-4 text-[#3B82F6] animate-spin" />
                          ) : (
                            <Clock className="w-4 h-4 text-slate-600" />
                          )}
                          <span>
                            0{idx + 1}. {stage}
                          </span>
                        </div>
                        <span className="text-xs font-mono">
                          {isDone ? 'Done' : isCurrent ? 'In Progress' : 'Queued'}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {scan.scan_status === 'Completed' && (
                  <div className="pt-2 flex justify-end">
                    <Link
                      to={`/bugs?projectId=${scan.project_id}`}
                      className="px-5 py-2.5 bg-[#3B82F6] hover:bg-[#2563EB] text-white text-sm font-semibold rounded-lg inline-flex items-center gap-2"
                    >
                      <span>View Detected Bugs ({scan.total_bugs})</span>
                      <ArrowRight className="w-4 h-4" />
                    </Link>
                  </div>
                )}
              </div>

              <div className="lg:col-span-5 rounded-xl bg-[#111C2D] border border-slate-800 overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">File Diagnostic Status</h3>
                  <span className="text-xs font-mono text-slate-400 tabular-nums">
                    {files.length} files
                  </span>
                </div>
                <div className="max-h-96 overflow-y-auto divide-y divide-slate-800/70">
                  {files.map((f) => {
                    const df = diagFilesByPath.get(f.file_path);
                    const isWrong = df?.status === 'wrong';
                    return (
                      <div key={f.id} className="px-5 py-2.5 flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono text-slate-200 truncate">{f.file_path}</span>
                        <div className="flex items-center gap-2 shrink-0 font-mono tabular-nums">
                          {df ? (
                            isWrong ? (
                              <span className="inline-flex items-center gap-1 text-red-400">
                                <X className="w-3 h-3" /> {df.error_count} wrong
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-emerald-400">
                                <Check className="w-3 h-3" /> right
                              </span>
                            )
                          ) : (
                            <span className="text-slate-500">{f.programming_language}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-8 rounded-xl bg-[#111C2D] border border-slate-800 text-center">
              <p className="text-sm text-slate-300">No scans run for this project yet.</p>
              <button
                type="button"
                onClick={handleTriggerScan}
                className="mt-4 px-5 py-2 text-xs font-semibold bg-[#3B82F6] text-white rounded-lg"
              >
                Start First Scan
              </button>
            </div>
          )}

          {selectedProjectId && (
            <LiveCodeInspector
              diagnostics={diagnostics}
              projects={projects}
              selectedProjectId={selectedProjectId}
              onSelectProject={(pid) => {
                setSelectedProjectId(pid);
                setSearchParams({ projectId: String(pid) });
              }}
              sseConnected={sseConnected}
              lastSyncedAt={lastSyncedAt}
              onRefreshRequested={() => selectedProjectId && loadDiagnostics(selectedProjectId)}
            />
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
