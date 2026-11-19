import { Download, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SeverityText, StatusText } from '../components/StatusLabel.tsx';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { projectService, reportService } from '../services/domainServices.ts';
import type { Bug, Patch, Project, TestResult } from '../types/autopatch.ts';

export function FinalReportPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const projectIdParam = searchParams.get('projectId');

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(
    projectIdParam ? Number(projectIdParam) : null
  );
  const [report, setReport] = useState<{
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
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<'markdown' | 'json' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (projectIdParam) {
      const parsed = Number(projectIdParam);
      if (Number.isFinite(parsed) && parsed > 0) {
        setSelectedId((prev) => (prev === parsed ? prev : parsed));
      }
    }
  }, [projectIdParam]);

  useEffect(() => {
    projectService
      .list()
      .then((res) => {
        setProjects(res.projects);
        const initialId = selectedId || res.projects[0]?.id || null;
        if (initialId) setSelectedId(initialId);
      })
      .catch((err: unknown) => {
        setProjects([]);
        setError(err instanceof Error ? err.message : 'Failed to load projects.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setError('');
    reportService
      .getReport(selectedId)
      .then((res) => setReport(res.report))
      .catch((err: unknown) => {
        setReport(null);
        setError(err instanceof Error ? err.message : 'Failed to load report.');
      });
  }, [selectedId]);

  const handleDownload = async (format: 'markdown' | 'json') => {
    if (!selectedId) return;
    setDownloading(format);
    setError('');
    try {
      await reportService.downloadReport(selectedId, format);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to download report.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <DashboardLayout
      title="Final Bug Report"
      breadcrumb="Reports / Audit Summary"
      action={
        selectedId ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={downloading !== null}
              onClick={() => handleDownload('markdown')}
              className="px-3.5 py-2 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-60 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              {downloading === 'markdown' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>Download Report (.md)</span>
            </button>
            <button
              type="button"
              disabled={downloading !== null}
              onClick={() => handleDownload('json')}
              className="px-3.5 py-2 text-xs font-semibold text-slate-200 bg-[#111C2D] border border-slate-700 hover:border-slate-500 disabled:opacity-60 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              {downloading === 'json' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>JSON</span>
            </button>
          </div>
        ) : null
      }
    >
      {error && (
        <div className="mb-4 p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
          {error}
        </div>
      )}
      {loading ? (
        <div className="p-8 text-xs text-slate-400">Loading project reports...</div>
      ) : !report ? (
        <div className="p-8 rounded-xl bg-[#111C2D] border border-slate-800 text-center text-sm text-slate-400">
          Upload and scan a project to generate an exportable validation report.
        </div>
      ) : (
        <div className="space-y-6">
          <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-400">Report Project:</label>
              <select
                value={selectedId ?? ''}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setSelectedId(id);
                  setSearchParams({ projectId: String(id) });
                }}
                className="px-3.5 py-2 text-xs bg-[#080F1D] border border-slate-700 rounded-lg text-white"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.project_name} ({p.programming_language})
                  </option>
                ))}
              </select>
            </div>
            <span className="text-xs font-mono text-slate-400 tabular-nums">
              Generated {report.generated_at.slice(0, 19).replace('T', ' ')}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800">
              <p className="text-xs text-slate-400">Total Bugs</p>
              <p className="mt-1.5 text-2xl font-display font-bold text-white tabular-nums">
                {report.summary.total_bugs}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800">
              <p className="text-xs text-slate-400">Bugs Fixed</p>
              <p className="mt-1.5 text-2xl font-display font-bold text-emerald-400 tabular-nums">
                {report.summary.bugs_fixed}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800">
              <p className="text-xs text-slate-400">Approved / Applied Patches</p>
              <p className="mt-1.5 text-2xl font-display font-bold text-[#3B82F6] tabular-nums">
                {report.summary.patches_approved_or_applied} / {report.summary.patches_generated}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800">
              <p className="text-xs text-slate-400">Validation Tests Passed</p>
              <p className="mt-1.5 text-2xl font-display font-bold text-[#D5AD60] tabular-nums">
                {report.summary.tests_passed} / {report.summary.tests_total}
              </p>
            </div>
          </div>

          <div className="p-6 rounded-xl bg-[#111C2D] border border-slate-800">
            <h2 className="text-base font-display font-semibold text-white mb-4">
              Severity Breakdown & Root Causes
            </h2>
            <div className="flex flex-wrap gap-6 text-xs font-mono text-slate-300 pb-4 mb-4 border-b border-slate-800 tabular-nums">
              {Object.entries(report.summary.severity_distribution).map(([sev, count]) => (
                <span key={sev}>
                  {sev}: <strong className="text-white">{count}</strong>
                </span>
              ))}
            </div>
            <div className="divide-y divide-slate-800/70">
              {report.bugs.map((b) => (
                <div key={b.id} className="py-4 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3 text-sm">
                      <span className="font-mono text-xs text-[#D5AD60]">{b.bug_code}</span>
                      <span className="font-semibold text-white">{b.bug_title}</span>
                      <span className="font-mono text-xs text-slate-400">
                        {b.file_path}:{b.start_line}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <SeverityText severity={b.severity} />
                      <StatusText status={b.bug_status} />
                    </div>
                  </div>
                  <p className="text-xs text-slate-400">{b.root_cause || b.bug_description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
