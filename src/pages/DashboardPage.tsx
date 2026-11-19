import { ArrowUpRight, Eye, FolderGit2, Loader2, Play, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { LiveCodeInspector } from '../components/LiveCodeInspector.tsx';
import { RecentActivityWidget } from '../components/RecentActivityWidget.tsx';
import { StatusText } from '../components/StatusLabel.tsx';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { getAccessToken } from '../services/api.ts';
import { projectService } from '../services/domainServices.ts';
import type { DashboardSummary } from '../types/autopatch.ts';

const SEVERITY_COLORS: Record<string, string> = {
  Critical: '#EF4444',
  High: '#D5AD60',
  Medium: '#3B82F6',
  Low: '#64748B',
};

export function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const inspectorRef = useRef<HTMLDivElement | null>(null);

  const loadSummary = useCallback(
    async (projectIdOverride?: number | null) => {
      try {
        const res = await projectService.dashboard(
          projectIdOverride ?? selectedProjectId ?? undefined
        );
        setData(res);
        setError('');
        if (!selectedProjectId && res.active_diagnostics?.project.id) {
          setSelectedProjectId(res.active_diagnostics.project.id);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load dashboard.');
      } finally {
        setLoading(false);
      }
    },
    [selectedProjectId]
  );

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  // Real-time Server-Sent Events (SSE) subscription for live values & line/file diagnostics
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    const url = projectService.streamUrl(selectedProjectId ?? undefined);
    const es = new EventSource(url);

    es.onopen = () => {
      setSseConnected(true);
    };

    es.addEventListener('snapshot', (evt) => {
      try {
        const payload = JSON.parse((evt as MessageEvent).data) as DashboardSummary;
        setData(payload);
        setLoading(false);
        setError('');
        setSseConnected(true);
        if (!selectedProjectId && payload.active_diagnostics?.project.id) {
          setSelectedProjectId(payload.active_diagnostics.project.id);
        }
      } catch {
        // Ignore malformed frame
      }
    });

    es.onerror = () => {
      setSseConnected(false);
    };

    return () => {
      es.close();
      setSseConnected(false);
    };
  }, [selectedProjectId]);

  const handleSelectProjectToInspect = (projectId: number) => {
    if (projectId !== selectedProjectId) {
      setSelectedProjectId(projectId);
    } else {
      void loadSummary(projectId);
    }
    inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleCreateAndScanSample = async () => {
    setActionBusy(true);
    try {
      const { project } = await projectService.createSample();
      await projectService.startScan(project.id);
      setSelectedProjectId(project.id);
      await loadSummary(project.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to launch sample project.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleDeleteProject = async (id: number) => {
    try {
      await projectService.delete(id);
      if (selectedProjectId === id) {
        setSelectedProjectId(null);
      }
      await loadSummary(selectedProjectId === id ? null : selectedProjectId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete project.');
    }
  };

  const handleRescan = async (id: number) => {
    try {
      setSelectedProjectId(id);
      await projectService.startScan(id);
      await loadSummary(id);
      inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start scan.');
    }
  };

  const statCards = data
    ? [
        { label: 'Total Projects', value: data.stats.total_projects, accent: 'text-white' },
        { label: 'Projects Scanned', value: data.stats.projects_scanned, accent: 'text-[#3B82F6]' },
        { label: 'Bugs Detected', value: data.stats.bugs_detected, accent: 'text-white' },
        { label: 'Critical Bugs', value: data.stats.critical_bugs, accent: 'text-red-400' },
        { label: 'Bugs Fixed', value: data.stats.bugs_fixed, accent: 'text-emerald-400' },
        { label: 'Pending Review', value: data.stats.pending_review, accent: 'text-[#D5AD60]' },
      ]
    : [];

  return (
    <DashboardLayout
      title="Developer Dashboard"
      breadcrumb="Workspace / Real-Time Diagnostics"
      action={
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            disabled={actionBusy}
            onClick={handleCreateAndScanSample}
            className="px-3.5 py-2 text-xs font-semibold text-[#D5AD60] bg-[#080F1D] border border-slate-700 hover:border-[#D5AD60]/60 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            {actionBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            <span>Scan Sample Python</span>
          </button>
          <Link
            to="/upload"
            className="px-4 py-2 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Quick Upload</span>
          </Link>
        </div>
      }
    >
      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg bg-[#111C2D] border border-slate-800 animate-pulse" />
          ))}
        </div>
      ) : !data && error ? (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-300">
          {error}
        </div>
      ) : data && data.stats.total_projects === 0 ? (
        <div className="p-10 rounded-xl bg-[#111C2D] border border-slate-800 text-center max-w-2xl mx-auto mt-6">
          {error && (
            <div className="mb-5 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300 text-left">
              {error}
            </div>
          )}
          <FolderGit2 className="w-10 h-10 text-[#3B82F6] mx-auto mb-3" />
          <h2 className="text-xl font-display font-bold text-white">No projects uploaded yet</h2>
          <p className="mt-2 text-sm text-slate-400">
            Upload a ZIP archive, clone a public GitHub repository, or initialize our sample multi-module Python workspace to run live AST scanning, AI root-cause diagnosis, and real-time Red/Green line inspection.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              to="/upload"
              className="px-5 py-2.5 text-sm font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg inline-flex items-center gap-2"
            >
              <Upload className="w-4 h-4" />
              <span>Upload Project</span>
            </Link>
            <button
              type="button"
              disabled={actionBusy}
              onClick={handleCreateAndScanSample}
              className="px-5 py-2.5 text-sm font-semibold text-[#D5AD60] bg-[#080F1D] border border-slate-700 hover:border-[#D5AD60]/60 rounded-lg inline-flex items-center gap-2"
            >
              {actionBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              <span>Load & Scan Sample Python Project</span>
            </button>
          </div>
        </div>
      ) : data ? (
        <div className="space-y-8">
          {error && (
            <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300 flex items-center justify-between gap-3">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError('')}
                className="text-red-200 hover:text-white underline shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}
          {/* Live KPI Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            {statCards.map((c) => (
              <div key={c.label} className="p-4 rounded-xl bg-[#111C2D] border border-slate-800">
                <p className="text-xs text-slate-400 truncate">{c.label}</p>
                <p className={`mt-2 text-2xl font-display font-bold font-mono tabular-nums ${c.accent}`}>
                  {c.value}
                </p>
              </div>
            ))}
          </div>

          {/* Real-Time File & Line Code Inspector (Red = Wrong, Green = Right) */}
          <div ref={inspectorRef}>
            <LiveCodeInspector
              diagnostics={data.active_diagnostics ?? null}
              projects={data.recent_projects}
              selectedProjectId={selectedProjectId}
              onSelectProject={handleSelectProjectToInspect}
              sseConnected={sseConnected}
              lastSyncedAt={data.server_time}
              onRefreshRequested={() => loadSummary()}
            />
          </div>

          {/* Severity & Detection/Repair Trend Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 p-6 rounded-xl bg-[#111C2D] border border-slate-800">
              <h2 className="text-base font-display font-semibold text-white mb-1">
                Bug Severity Distribution
              </h2>
              <p className="text-xs text-slate-400 mb-4">Across all scanned project files</p>
              {data.severity_distribution.length === 0 ? (
                <div className="h-56 flex items-center justify-center text-xs text-slate-500">
                  Run a project scan to populate severity metrics.
                </div>
              ) : (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={data.severity_distribution}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={52}
                        outerRadius={82}
                        paddingAngle={3}
                      >
                        {data.severity_distribution.map((entry) => (
                          <Cell
                            key={entry.name}
                            fill={SEVERITY_COLORS[entry.name] || '#3B82F6'}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#080F1D',
                          borderColor: '#1E293B',
                          borderRadius: '8px',
                          fontSize: '12px',
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="mt-2 flex flex-wrap justify-center gap-4 text-xs text-slate-300">
                {data.severity_distribution.map((s) => (
                  <span key={s.name} className="inline-flex items-center gap-1.5 tabular-nums">
                    <span
                      className="w-2.5 h-2.5 rounded-sm"
                      style={{ backgroundColor: SEVERITY_COLORS[s.name] || '#3B82F6' }}
                    />
                    {s.name}: {s.value}
                  </span>
                ))}
              </div>
            </div>

            <div className="lg:col-span-7 p-6 rounded-xl bg-[#111C2D] border border-slate-800">
              <h2 className="text-base font-display font-semibold text-white mb-1">
                Bug Detection & Repair Trend
              </h2>
              <p className="text-xs text-slate-400 mb-4">Detected vs validated fixes by scan date</p>
              {data.weekly_trend.length === 0 ? (
                <div className="h-60 flex items-center justify-center text-xs text-slate-500">
                  No daily detection records yet.
                </div>
              ) : (
                <div className="h-60">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.weekly_trend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                      <XAxis dataKey="day" stroke="#64748B" fontSize={11} />
                      <YAxis stroke="#64748B" fontSize={11} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#080F1D',
                          borderColor: '#1E293B',
                          borderRadius: '8px',
                          fontSize: '12px',
                        }}
                      />
                      <Bar dataKey="detected" name="Detected (Wrong)" fill="#EF4444" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="fixed" name="Fixed (Right)" fill="#16A34A" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          {/* Recent Projects + Recent Activity Widget */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 rounded-xl bg-[#111C2D] border border-slate-800 overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-base font-display font-semibold text-white">Recent Projects</h2>
                <Link to="/upload" className="text-xs text-[#3B82F6] hover:underline">
                  Add Project
                </Link>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#080F1D]/60 text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-3 px-4 font-medium">Project</th>
                      <th className="py-3 px-4 font-medium">Language</th>
                      <th className="py-3 px-4 font-medium text-right">Wrong / Fixed</th>
                      <th className="py-3 px-4 font-medium">Status</th>
                      <th className="py-3 px-4 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {data.recent_projects.map((p) => {
                      const total = p.bug_count ?? 0;
                      const fixed = p.fixed_count ?? 0;
                      const open = Math.max(0, total - fixed);
                      return (
                        <tr
                          key={p.id}
                          className={`transition-colors ${
                            selectedProjectId === p.id ? 'bg-[#3B82F6]/8' : 'hover:bg-slate-800/30'
                          }`}
                        >
                          <td className="py-3 px-4">
                            <button
                              type="button"
                              onClick={() => handleSelectProjectToInspect(p.id)}
                              className="font-medium text-white hover:text-[#3B82F6] text-left"
                            >
                              {p.project_name}
                            </button>
                          </td>
                          <td className="py-3 px-4 text-slate-400">{p.programming_language}</td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            <span className={open > 0 ? 'text-red-400' : 'text-slate-400'}>{open}</span>
                            <span className="text-slate-600 mx-1">/</span>
                            <span className="text-emerald-400">{fixed}</span>
                          </td>
                          <td className="py-3 px-4">
                            <StatusText status={p.project_status} />
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleSelectProjectToInspect(p.id)}
                                className="p-1.5 text-slate-400 hover:text-white"
                                title="Inspect files & lines"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRescan(p.id)}
                                className="p-1.5 text-slate-400 hover:text-[#3B82F6]"
                                title="Run live scan"
                              >
                                <Play className="w-3.5 h-3.5" />
                              </button>
                              <Link
                                to={`/bugs?projectId=${p.id}`}
                                className="p-1.5 text-slate-400 hover:text-white"
                                title="View bugs"
                              >
                                <ArrowUpRight className="w-3.5 h-3.5" />
                              </Link>
                              <button
                                type="button"
                                onClick={() => handleDeleteProject(p.id)}
                                className="p-1.5 text-slate-400 hover:text-red-400"
                                title="Delete project"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <RecentActivityWidget
              tasks={data.recent_tasks || []}
              onInspectProject={handleSelectProjectToInspect}
            />
          </div>
        </div>
      ) : null}
    </DashboardLayout>
  );
}
