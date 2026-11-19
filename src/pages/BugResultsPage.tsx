import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SeverityText, StatusText } from '../components/StatusLabel.tsx';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { bugService, projectService } from '../services/domainServices.ts';
import type { Bug, Project } from '../types/autopatch.ts';

export function BugResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const projectFilter = searchParams.get('projectId') || 'all';

  const [projects, setProjects] = useState<Project[]>([]);
  const [bugs, setBugs] = useState<Bug[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');

  useEffect(() => {
    setLoading(true);
    setError('');
    const pid = Number(projectFilter);
    const useProjectFilter = projectFilter !== 'all' && Number.isFinite(pid) && pid > 0;
    Promise.all([
      projectService.list(),
      useProjectFilter ? bugService.listByProject(pid) : bugService.listAll(),
    ])
      .then(([projRes, bugRes]) => {
        setProjects(projRes.projects);
        setBugs(bugRes.bugs);
      })
      .catch((err: unknown) => {
        setBugs([]);
        setError(err instanceof Error ? err.message : 'Unable to load bug detection results.');
      })
      .finally(() => setLoading(false));
  }, [projectFilter]);

  const filtered = useMemo(() => {
    return bugs.filter((b) => {
      if (severityFilter !== 'All' && b.severity !== severityFilter) return false;
      if (statusFilter !== 'All' && b.bug_status !== statusFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          b.bug_code.toLowerCase().includes(q) ||
          b.bug_title.toLowerCase().includes(q) ||
          b.file_path.toLowerCase().includes(q) ||
          b.bug_category.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [bugs, severityFilter, statusFilter, search]);

  return (
    <DashboardLayout
      title="Bug Detection Results"
      breadcrumb="Analysis / Detected Issues"
      action={
        <Link
          to="/upload"
          className="px-4 py-2 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg whitespace-nowrap shrink-0"
        >
          Scan Another Project
        </Link>
      }
    >
      <div className="space-y-6">
        {/* Search & Filters */}
        <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by Bug ID, title, file, or category..."
              className="w-full pl-9 pr-3.5 py-2 text-xs bg-[#080F1D] border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-[#3B82F6]"
            />
          </div>

          <select
            value={projectFilter}
            onChange={(e) => {
              if (e.target.value === 'all') setSearchParams({});
              else setSearchParams({ projectId: e.target.value });
            }}
            className="px-3 py-2 text-xs bg-[#080F1D] border border-slate-700 rounded-lg text-slate-200"
          >
            <option value="all">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.project_name}
              </option>
            ))}
          </select>

          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="px-3 py-2 text-xs bg-[#080F1D] border border-slate-700 rounded-lg text-slate-200"
          >
            {['All', 'Critical', 'High', 'Medium', 'Low'].map((s) => (
              <option key={s} value={s}>
                Severity: {s}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-xs bg-[#080F1D] border border-slate-700 rounded-lg text-slate-200"
          >
            {['All', 'Open', 'Patched', 'Fixed', 'Dismissed'].map((s) => (
              <option key={s} value={s}>
                Status: {s}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
            {error}
          </div>
        )}

        {/* Bug Table */}
        <div className="rounded-xl bg-[#111C2D] border border-slate-800 overflow-hidden">
          {loading ? (
            <div className="p-8 text-xs text-slate-400">Loading bug reports...</div>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm text-slate-300">No matching bug findings.</p>
              <p className="text-xs text-slate-500 mt-1">
                Upload and scan a project to inspect detected bugs here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#080F1D]/80 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4 font-medium">Bug ID</th>
                    <th className="py-3 px-4 font-medium">Bug Title</th>
                    <th className="py-3 px-4 font-medium">File</th>
                    <th className="py-3 px-4 font-medium text-right">Line</th>
                    <th className="py-3 px-4 font-medium">Severity</th>
                    <th className="py-3 px-4 font-medium">Category</th>
                    <th className="py-3 px-4 font-medium text-right">Confidence</th>
                    <th className="py-3 px-4 font-medium">Status</th>
                    <th className="py-3 px-4 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {filtered.map((b) => (
                    <tr key={b.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 px-4 font-mono text-slate-300 tabular-nums whitespace-nowrap">
                        {b.bug_code}
                      </td>
                      <td className="py-3 px-4 font-medium text-white max-w-xs truncate">
                        {b.bug_title}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-300 whitespace-nowrap">
                        {b.file_path}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-400">
                        {b.start_line}
                      </td>
                      <td className="py-3 px-4">
                        <SeverityText severity={b.severity} />
                      </td>
                      <td className="py-3 px-4 text-slate-300 whitespace-nowrap">
                        {b.bug_category}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">
                        {Math.round(b.confidence_score * 100)}%
                      </td>
                      <td className="py-3 px-4">
                        <StatusText status={b.bug_status} />
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <Link
                          to={`/root-cause?bugId=${b.id}`}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-md inline-block"
                        >
                          View Details
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
