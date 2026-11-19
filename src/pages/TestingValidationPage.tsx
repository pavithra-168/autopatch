import { Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { StatusText } from '../components/StatusLabel.tsx';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { patchService, testService } from '../services/domainServices.ts';
import type { Patch, TestResult } from '../types/autopatch.ts';

export function TestingValidationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const patchIdParam = searchParams.get('patchId');

  const [patches, setPatches] = useState<Patch[]>([]);
  const [selectedPatchId, setSelectedPatchId] = useState<number | null>(
    patchIdParam ? Number(patchIdParam) : null
  );
  const [validationStatus, setValidationStatus] = useState('Validation Incomplete');
  const [beforeTests, setBeforeTests] = useState<TestResult[]>([]);
  const [afterTests, setAfterTests] = useState<TestResult[]>([]);
  const [execTime, setExecTime] = useState(0);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (patchIdParam) {
      const parsed = Number(patchIdParam);
      if (Number.isFinite(parsed) && parsed > 0) {
        setSelectedPatchId((prev) => (prev === parsed ? prev : parsed));
      }
    }
  }, [patchIdParam]);

  useEffect(() => {
    patchService
      .listAll()
      .then((res) => {
        setPatches(res.patches);
        const targetId = selectedPatchId || res.patches[0]?.id || null;
        setSelectedPatchId(targetId);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load patches.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setValidationStatus('Validation Incomplete');
    setBeforeTests([]);
    setAfterTests([]);
    setExecTime(0);
    setError('');
    if (!selectedPatchId) return;

    let cancelled = false;
    testService
      .getResults(selectedPatchId)
      .then((res) => {
        if (cancelled) return;
        setValidationStatus(res.validation_status);
        setBeforeTests(res.before);
        setAfterTests(res.after);
        setExecTime(res.summary.execution_time);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unable to load test results.');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPatchId]);

  const handleRunTests = async () => {
    if (!selectedPatchId) return;
    setRunning(true);
    setError('');
    try {
      const res = await testService.run(selectedPatchId);
      setValidationStatus(res.validation_status);
      setBeforeTests(res.before.results);
      setAfterTests(res.after.results);
      setExecTime(res.after.execution_time);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Test execution failed.');
    } finally {
      setRunning(false);
    }
  };

  const totalTests = afterTests.length;
  const passedCount = afterTests.filter((t) => t.test_status === 'Passed').length;
  const failedCount = afterTests.filter((t) => t.test_status === 'Failed').length;

  return (
    <DashboardLayout
      title="Testing & Validation"
      breadcrumb="Verification / Sandboxed Test Runner"
      action={
        selectedPatchId ? (
          <button
            type="button"
            disabled={running}
            onClick={handleRunTests}
            className="px-4 py-2 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-60 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            <span>{running ? 'Running Sandbox...' : 'Run Tests'}</span>
          </button>
        ) : null
      }
    >
      {loading ? (
        <div className="p-8 text-xs text-slate-400">Loading test suite state...</div>
      ) : patches.length === 0 ? (
        <div className="p-8 rounded-xl bg-[#111C2D] border border-slate-800 text-center">
          <p className="text-sm text-slate-300">No patches available to test yet.</p>
          <Link to="/patches" className="mt-4 inline-block px-4 py-2 text-xs bg-[#3B82F6] text-white rounded-lg">
            Generate a Patch First
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-400">Validate Patch:</label>
              <select
                value={selectedPatchId ?? ''}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setSelectedPatchId(id);
                  setSearchParams({ patchId: String(id) });
                }}
                className="px-3.5 py-2 text-xs bg-[#080F1D] border border-slate-700 rounded-lg text-white"
              >
                {patches.map((p) => (
                  <option key={p.id} value={p.id}>
                    Patch #{p.id} · {p.bug_code} ({p.file_path})
                  </option>
                ))}
              </select>
            </div>
            <StatusText status={validationStatus} />
          </div>

          {error && (
            <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              {error}
            </div>
          )}

          {/* Summary KPI Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800">
              <p className="text-xs text-slate-400">Total Tests</p>
              <p className="mt-1.5 text-2xl font-display font-bold text-white tabular-nums">
                {totalTests}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800">
              <p className="text-xs text-slate-400">Passed</p>
              <p className="mt-1.5 text-2xl font-display font-bold text-emerald-400 tabular-nums">
                {passedCount}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800">
              <p className="text-xs text-slate-400">Failed</p>
              <p className="mt-1.5 text-2xl font-display font-bold text-red-400 tabular-nums">
                {failedCount}
              </p>
            </div>
            <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800">
              <p className="text-xs text-slate-400">Execution Time</p>
              <p className="mt-1.5 text-2xl font-display font-bold text-[#D5AD60] tabular-nums">
                {execTime.toFixed(2)}s
              </p>
            </div>
          </div>

          {afterTests.length === 0 ? (
            <div className="p-10 rounded-xl bg-[#111C2D] border border-slate-800 text-center">
              <p className="text-sm text-slate-200">
                Click Run Tests to execute project unit tests and edge-case probes against both original and patched code in an isolated sandbox.
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-[#111C2D] border border-slate-800 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">
                  Before-Fix vs After-Fix Regression Matrix
                </h2>
                <Link to="/reports" className="text-xs text-[#3B82F6] hover:underline">
                  View Final Report →
                </Link>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#080F1D]/80 text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-3 px-4 font-medium">Test Case</th>
                      <th className="py-3 px-4 font-medium">Description</th>
                      <th className="py-3 px-4 font-medium">Before Fix</th>
                      <th className="py-3 px-4 font-medium">After Fix</th>
                      <th className="py-3 px-4 font-medium text-right">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {afterTests.map((t, idx) => {
                      const beforeMatch = beforeTests.find((b) => b.test_name === t.test_name);
                      return (
                        <tr key={`${t.test_name}-${idx}`} className="hover:bg-slate-800/30">
                          <td className="py-3 px-4 font-mono text-white">{t.test_name}</td>
                          <td className="py-3 px-4 text-slate-300">
                            <p>{t.test_description}</p>
                            {t.error_message && (
                              <p className="mt-1 font-mono text-[11px] text-red-300">
                                {t.error_message}
                              </p>
                            )}
                            {t.output && !t.error_message && (
                              <p className="mt-1 font-mono text-[11px] text-slate-500">
                                {t.output}
                              </p>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <StatusText status={beforeMatch?.test_status || 'N/A'} />
                          </td>
                          <td className="py-3 px-4">
                            <StatusText status={t.test_status} />
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-400">
                            {t.execution_time.toFixed(3)}s
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
