import { Loader2, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { StatusText } from '../components/StatusLabel.tsx';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { patchService, reportService } from '../services/domainServices.ts';
import type { ChangeHistoryItem } from '../types/autopatch.ts';

export function BugHistoryPage() {
  const [history, setHistory] = useState<ChangeHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [rollingBackId, setRollingBackId] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadHistory = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await reportService.history();
      setHistory(res.history);
    } catch (err: unknown) {
      setHistory([]);
      setError(err instanceof Error ? err.message : 'Failed to load audit history.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const handleRollback = async (patchId: number) => {
    setMessage('');
    setError('');
    setRollingBackId(patchId);
    try {
      await patchService.rollback(patchId);
      setMessage(`Patch #${patchId} rolled back safely from immutable backup.`);
      await loadHistory();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Rollback failed.');
    } finally {
      setRollingBackId(null);
    }
  };

  return (
    <DashboardLayout title="Bug History" breadcrumb="Audit / Change Log & Rollback">
      {error && (
        <div className="mb-4 p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-4 p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
          {message}
        </div>
      )}

      <div className="rounded-xl bg-[#111C2D] border border-slate-800 overflow-hidden">
        {loading ? (
          <div className="p-8 text-xs text-slate-400">Loading audit history...</div>
        ) : history.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">
            No change history recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#080F1D]/80 text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4 font-medium">Timestamp</th>
                  <th className="py-3 px-4 font-medium">Project</th>
                  <th className="py-3 px-4 font-medium">Bug</th>
                  <th className="py-3 px-4 font-medium">Action</th>
                  <th className="py-3 px-4 font-medium">Description</th>
                  <th className="py-3 px-4 font-medium">Patch / Test Status</th>
                  <th className="py-3 px-4 font-medium text-right">Rollback</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {history.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-mono text-slate-400 tabular-nums whitespace-nowrap">
                      {item.created_at.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="py-3 px-4 font-medium text-white whitespace-nowrap">
                      {item.project_name}
                    </td>
                    <td className="py-3 px-4 font-mono text-[#D5AD60] whitespace-nowrap">
                      {item.bug_code || '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-300 whitespace-nowrap">
                      {item.action_type}
                    </td>
                    <td className="py-3 px-4 text-slate-300 max-w-md">{item.description}</td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {item.patch_status ? <StatusText status={item.patch_status} /> : '—'}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      {item.patch_id && item.patch_status === 'Applied' && item.action_type === 'PATCH_APPLIED' ? (
                        <button
                          type="button"
                          disabled={rollingBackId === item.patch_id}
                          onClick={() => handleRollback(item.patch_id!)}
                          className="px-3 py-1.5 text-xs font-medium text-[#D5AD60] bg-[#080F1D] border border-slate-700 hover:border-[#D5AD60]/60 disabled:opacity-50 rounded-md inline-flex items-center gap-1.5"
                        >
                          {rollingBackId === item.patch_id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <RotateCcw className="w-3 h-3" />
                          )}
                          <span>{rollingBackId === item.patch_id ? 'Rolling Back...' : 'Rollback'}</span>
                        </button>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
