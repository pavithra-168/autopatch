import { CheckCircle2, GitCompare, Loader2, Sparkles, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { StatusText } from '../components/StatusLabel.tsx';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { bugService, patchService } from '../services/domainServices.ts';
import type { Bug, Patch } from '../types/autopatch.ts';

export function PatchSuggestionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const bugIdParam = searchParams.get('bugId');
  const patchIdParam = searchParams.get('patchId');

  const [bugs, setBugs] = useState<Bug[]>([]);
  const [selectedBugId, setSelectedBugId] = useState<number | null>(
    bugIdParam ? Number(bugIdParam) : null
  );
  const [patches, setPatches] = useState<Patch[]>([]);
  const [activePatch, setActivePatch] = useState<Patch | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (bugIdParam) {
      const parsed = Number(bugIdParam);
      if (Number.isFinite(parsed) && parsed > 0) {
        setSelectedBugId((prev) => (prev === parsed ? prev : parsed));
      }
    }
  }, [bugIdParam]);

  useEffect(() => {
    bugService
      .listAll()
      .then((res) => {
        setBugs(res.bugs);
        const bid = selectedBugId || res.bugs[0]?.id || null;
        setSelectedBugId(bid);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load bugs.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setError('');
    if (!selectedBugId) return;
    bugService
      .get(selectedBugId)
      .then((res) => {
        setPatches(res.patches);
        if (patchIdParam) {
          const found = res.patches.find((p) => p.id === Number(patchIdParam));
          setActivePatch(found || res.patches[0] || null);
        } else {
          setActivePatch(res.patches[0] || null);
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load patches.');
      });
  }, [selectedBugId, patchIdParam]);

  const handleGenerate = async () => {
    if (!selectedBugId) return;
    setError('');
    setBusy(true);
    try {
      const res = await patchService.generate(selectedBugId);
      setPatches((prev) => [res.patch, ...prev]);
      setActivePatch(res.patch);
      setSearchParams({ bugId: String(selectedBugId), patchId: String(res.patch.id) });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to generate patch.');
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async () => {
    if (!activePatch) return;
    setBusy(true);
    setError('');
    try {
      const res = await patchService.approve(activePatch.id);
      const merged = { ...activePatch, ...res.patch };
      setActivePatch(merged);
      setPatches((prev) => prev.map((p) => (p.id === merged.id ? merged : p)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Approval failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!activePatch) return;
    setBusy(true);
    setError('');
    try {
      const res = await patchService.reject(activePatch.id);
      const merged = { ...activePatch, ...res.patch };
      setActivePatch(merged);
      setPatches((prev) => prev.map((p) => (p.id === merged.id ? merged : p)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Rejection failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DashboardLayout
      title="AI Patch Suggestions"
      breadcrumb="Repair / Candidate Patches"
      action={
        selectedBugId ? (
          <button
            type="button"
            disabled={busy}
            onClick={handleGenerate}
            className="px-4 py-2 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            <span>Generate Patch</span>
          </button>
        ) : null
      }
    >
      {loading ? (
        <div className="p-8 text-xs text-slate-400">Loading patch proposals...</div>
      ) : bugs.length === 0 ? (
        <div className="p-8 rounded-xl bg-[#111C2D] border border-slate-800 text-center">
          <p className="text-sm text-slate-300">No bugs detected yet.</p>
          <Link to="/upload" className="mt-4 inline-block px-4 py-2 text-xs bg-[#3B82F6] text-white rounded-lg">
            Upload Project
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs text-slate-400">Target Bug:</label>
              <select
                value={selectedBugId ?? ''}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setSelectedBugId(id);
                  setSearchParams({ bugId: String(id) });
                }}
                className="px-3.5 py-2 text-xs bg-[#080F1D] border border-slate-700 rounded-lg text-white"
              >
                {bugs.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.bug_code} · {b.bug_title} ({b.file_path})
                  </option>
                ))}
              </select>
              {patches.length > 1 && (
                <select
                  value={activePatch?.id ?? ''}
                  onChange={(e) => {
                    const p = patches.find((item) => item.id === Number(e.target.value));
                    if (p) setActivePatch(p);
                  }}
                  className="px-3 py-2 text-xs bg-[#080F1D] border border-slate-700 rounded-lg text-slate-200"
                >
                  {patches.map((p) => (
                    <option key={p.id} value={p.id}>
                      Patch #{p.id} ({p.patch_status})
                    </option>
                  ))}
                </select>
              )}
            </div>
            {activePatch && <StatusText status={activePatch.patch_status} />}
          </div>

          {error && (
            <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              {error}
            </div>
          )}

          {!activePatch ? (
            <div className="p-10 rounded-xl bg-[#111C2D] border border-slate-800 text-center">
              <p className="text-sm text-slate-200 font-medium">
                No patch generated for this bug yet.
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Click Generate Patch to synthesize a minimal fix without modifying original source files.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={handleGenerate}
                className="mt-5 px-5 py-2.5 text-xs font-semibold bg-[#3B82F6] hover:bg-[#2563EB] text-white rounded-lg inline-flex items-center gap-2"
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Generate Patch with Gemini AI</span>
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="p-6 rounded-xl bg-[#111C2D] border border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
                <div>
                  <p className="font-semibold text-white mb-1.5">Explanation of Modifications</p>
                  <p className="text-slate-300 leading-relaxed">{activePatch.explanation}</p>
                </div>
                <div>
                  <p className="font-semibold text-[#D5AD60] mb-1.5">Reason for Repair</p>
                  <p className="text-slate-300 leading-relaxed">{activePatch.repair_reason}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="rounded-xl bg-[#111C2D] border border-slate-800 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-800 text-xs font-medium text-red-400">
                    Original Code
                  </div>
                  <pre className="p-4 text-xs font-mono text-slate-300 bg-[#080F1D] overflow-x-auto max-h-96 leading-relaxed">
                    {activePatch.original_code}
                  </pre>
                </div>

                <div className="rounded-xl bg-[#111C2D] border border-slate-800 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-800 text-xs font-medium text-emerald-400">
                    Suggested Corrected Code
                  </div>
                  <pre className="p-4 text-xs font-mono text-emerald-200 bg-[#080F1D] overflow-x-auto max-h-96 leading-relaxed">
                    {activePatch.proposed_code}
                  </pre>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  disabled={busy || activePatch.patch_status === 'Applied'}
                  onClick={handleReject}
                  className="px-4 py-2 text-xs font-semibold text-red-300 bg-[#111C2D] border border-red-500/30 hover:bg-red-500/10 disabled:opacity-40 rounded-lg inline-flex items-center gap-1.5"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  <span>Reject Patch</span>
                </button>
                <button
                  type="button"
                  disabled={busy || activePatch.patch_status === 'Applied'}
                  onClick={handleApprove}
                  className="px-4 py-2 text-xs font-semibold text-emerald-300 bg-[#111C2D] border border-emerald-500/30 hover:bg-emerald-500/10 disabled:opacity-40 rounded-lg inline-flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{activePatch.patch_status === 'Applied' ? 'Applied' : 'Approve Patch'}</span>
                </button>
                <Link
                  to={`/compare?patchId=${activePatch.id}`}
                  className="px-4 py-2 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg inline-flex items-center gap-1.5"
                >
                  <GitCompare className="w-3.5 h-3.5" />
                  <span>Compare Side-by-Side</span>
                </Link>
              </div>
            </div>
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
