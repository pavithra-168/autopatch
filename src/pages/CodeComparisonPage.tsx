import { CheckCircle2, FlaskConical, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { DiffViewer } from '../components/DiffViewer.tsx';
import { StatusText } from '../components/StatusLabel.tsx';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { patchService } from '../services/domainServices.ts';
import type { Patch } from '../types/autopatch.ts';

export function CodeComparisonPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const patchIdParam = searchParams.get('patchId');

  const [patches, setPatches] = useState<Patch[]>([]);
  const [patch, setPatch] = useState<Patch | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    setError('');
    setSuccess('');
    patchService
      .listAll()
      .then((res) => {
        setPatches(res.patches);
        const target = patchIdParam
          ? res.patches.find((p) => p.id === Number(patchIdParam))
          : res.patches[0];
        setPatch(target || null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load patches.');
      })
      .finally(() => setLoading(false));
  }, [patchIdParam]);

  const handleApproveAndApply = async () => {
    if (!patch) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await patchService.approve(patch.id);
      const res = await patchService.apply(patch.id);
      const merged = { ...patch, ...res.patch };
      setPatch(merged);
      setPatches((prev) => prev.map((p) => (p.id === merged.id ? merged : p)));
      setSuccess('Patch approved and safely applied with immutable backup preserved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to apply patch.');
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!patch) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const res = await patchService.reject(patch.id);
      const merged = { ...patch, ...res.patch };
      setPatch(merged);
      setPatches((prev) => prev.map((p) => (p.id === merged.id ? merged : p)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to reject patch.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DashboardLayout
      title="Code Comparison"
      breadcrumb="Review / Side-by-Side Diff"
      action={
        patch ? (
          <button
            type="button"
            onClick={() => navigate(`/testing?patchId=${patch.id}`)}
            className="px-4 py-2 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <FlaskConical className="w-3.5 h-3.5" />
            <span>Run Validation Tests</span>
          </button>
        ) : null
      }
    >
      {loading ? (
        <div className="p-8 text-xs text-slate-400">Loading code diffs...</div>
      ) : !patch ? (
        <div className="p-8 rounded-xl bg-[#111C2D] border border-slate-800 text-center">
          <p className="text-sm text-slate-300">No generated patches available to compare.</p>
          <Link to="/patches" className="mt-4 inline-block px-4 py-2 text-xs bg-[#3B82F6] text-white rounded-lg">
            Generate a Patch First
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-400">Patch:</label>
              <select
                value={patch.id}
                onChange={(e) => setSearchParams({ patchId: e.target.value })}
                className="px-3.5 py-2 text-xs bg-[#080F1D] border border-slate-700 rounded-lg text-white"
              >
                {patches.map((p) => (
                  <option key={p.id} value={p.id}>
                    Patch #{p.id} · {p.bug_code} ({p.file_path})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-4">
              <StatusText status={patch.patch_status} />
              <span className="text-slate-600">·</span>
              <StatusText status={patch.validation_status} />
            </div>
          </div>

          {error && (
            <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              {error}
            </div>
          )}
          {success && (
            <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
              {success}
            </div>
          )}

          <div className="p-5 rounded-xl bg-[#111C2D] border border-slate-800 text-xs text-slate-300">
            <span className="font-semibold text-white mr-2">Change Summary:</span>
            {patch.explanation}
          </div>

          <DiffViewer
            originalCode={patch.original_code}
            proposedCode={patch.proposed_code}
            filePath={patch.file_path || 'source.py'}
          />

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              disabled={busy || patch.patch_status === 'Applied'}
              onClick={handleReject}
              className="px-4 py-2.5 text-xs font-semibold text-red-300 bg-[#111C2D] border border-red-500/30 hover:bg-red-500/10 disabled:opacity-40 rounded-lg inline-flex items-center gap-1.5"
            >
              <XCircle className="w-4 h-4" />
              <span>Reject Changes</span>
            </button>
            <button
              type="button"
              disabled={busy || patch.patch_status === 'Applied'}
              onClick={handleApproveAndApply}
              className="px-5 py-2.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg inline-flex items-center gap-1.5"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              <span>
                {patch.patch_status === 'Applied' ? 'Applied to Workspace' : 'Approve & Apply Changes'}
              </span>
            </button>
            {patch.patch_status === 'Applied' && (
              <Link
                to={`/testing?patchId=${patch.id}`}
                className="px-5 py-2.5 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg inline-flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Proceed to Testing & Validation</span>
              </Link>
            )}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
