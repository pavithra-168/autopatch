import { ArrowRight, Cpu, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { SeverityText, StatusText } from '../components/StatusLabel.tsx';
import { DashboardLayout } from '../layouts/DashboardLayout.tsx';
import { bugService, patchService } from '../services/domainServices.ts';
import type { Bug } from '../types/autopatch.ts';

export function RootCausePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [allBugs, setAllBugs] = useState<Bug[]>([]);
  const [bugsLoaded, setBugsLoaded] = useState(false);
  const [bug, setBug] = useState<Bug | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [analyzingAI, setAnalyzingAI] = useState(false);
  const [generatingPatch, setGeneratingPatch] = useState(false);
  const [error, setError] = useState('');

  const bugIdParam = searchParams.get('bugId');

  useEffect(() => {
    bugService
      .listAll()
      .then((res) => {
        setAllBugs(res.bugs);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unable to load bugs.');
      })
      .finally(() => {
        setBugsLoaded(true);
      });
  }, []);

  const loadBug = async (id: number) => {
    setLoading(true);
    setError('');
    try {
      const res = await bugService.get(id);
      setBug(res.bug);
      setFileContent(res.file_content);
    } catch (err: unknown) {
      setBug(null);
      setFileContent('');
      setError(err instanceof Error ? err.message : 'Unable to load bug details.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const parsedId = bugIdParam ? Number(bugIdParam) : NaN;
    if (Number.isFinite(parsedId) && parsedId > 0) {
      void loadBug(parsedId);
      return;
    }
    if (!bugsLoaded) return;
    const firstId = allBugs[0]?.id;
    if (firstId) {
      void loadBug(firstId);
    } else {
      setBug(null);
      setFileContent('');
      setLoading(false);
    }
  }, [bugIdParam, bugsLoaded, allBugs]);

  const handleAnalyzeWithGemini = async () => {
    if (!bug) return;
    setError('');
    setAnalyzingAI(true);
    try {
      const res = await bugService.analyzeWithAI(bug.id);
      setBug(res.bug);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gemini root-cause analysis failed.');
    } finally {
      setAnalyzingAI(false);
    }
  };

  const handleGeneratePatch = async () => {
    if (!bug) return;
    setError('');
    setGeneratingPatch(true);
    try {
      const res = await patchService.generate(bug.id);
      navigate(`/patches?bugId=${bug.id}&patchId=${res.patch.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Patch generation failed.');
      setGeneratingPatch(false);
    }
  };

  return (
    <DashboardLayout
      title="Root Cause Analysis"
      breadcrumb="Diagnostics / Defect Explanation"
      action={
        bug ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={analyzingAI}
              onClick={handleAnalyzeWithGemini}
              className="px-3.5 py-2 text-xs font-semibold text-[#D5AD60] bg-[#111C2D] border border-slate-700 hover:border-[#D5AD60]/60 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              {analyzingAI ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cpu className="w-3.5 h-3.5" />}
              <span>Deepen with Gemini AI</span>
            </button>
            <button
              type="button"
              disabled={generatingPatch}
              onClick={handleGeneratePatch}
              className="px-4 py-2 text-xs font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              {generatingPatch ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
              <span>Generate Patch</span>
            </button>
          </div>
        ) : null
      }
    >
      {loading ? (
        <div className="p-8 text-xs text-slate-400">Loading root-cause telemetry...</div>
      ) : !bug ? (
        <div className="p-8 rounded-xl bg-[#111C2D] border border-slate-800 text-center">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              {error}
            </div>
          )}
          <p className="text-sm text-slate-300">No bugs available for inspection.</p>
          <Link to="/upload" className="mt-4 inline-block px-4 py-2 text-xs bg-[#3B82F6] text-white rounded-lg">
            Upload & Scan Project
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="p-4 rounded-xl bg-[#111C2D] border border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-400">Inspect Bug:</label>
              <select
                value={bug.id}
                onChange={(e) => setSearchParams({ bugId: e.target.value })}
                className="px-3.5 py-2 text-xs bg-[#080F1D] border border-slate-700 rounded-lg text-white"
              >
                {allBugs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.bug_code} · {item.bug_title} ({item.file_path})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <SeverityText severity={bug.severity} />
              <span className="text-slate-600">·</span>
              <StatusText status={bug.bug_status} />
              <span className="text-slate-600">·</span>
              <span className="font-mono text-slate-300 tabular-nums">
                Confidence {Math.round(bug.confidence_score * 100)}%
              </span>
            </div>
          </div>

          {error && (
            <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-6 space-y-4">
              <div className="p-6 rounded-xl bg-[#111C2D] border border-slate-800 space-y-4">
                <div>
                  <p className="text-xs font-mono text-[#D5AD60]">
                    {bug.bug_code} · {bug.file_path} (lines {bug.start_line}–{bug.end_line})
                  </p>
                  <h2 className="text-lg font-display font-bold text-white mt-1">{bug.bug_title}</h2>
                  <p className="text-sm text-slate-300 mt-2">{bug.bug_description}</p>
                </div>

                <div className="pt-4 border-t border-slate-800 space-y-3 text-xs">
                  <div>
                    <p className="font-semibold text-slate-200 mb-1">Root Cause Explanation</p>
                    <p className="text-slate-400 leading-relaxed">{bug.root_cause}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-200 mb-1">Why the Issue Occurs</p>
                    <p className="text-slate-400 leading-relaxed">{bug.why_it_occurs}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-200 mb-1">Triggering Input / Condition</p>
                    <p className="text-slate-400 leading-relaxed">{bug.triggering_condition}</p>
                  </div>
                </div>
              </div>

              <div className="p-6 rounded-xl bg-[#111C2D] border border-slate-800 space-y-3 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="font-semibold text-emerald-400 mb-1">Expected Behavior</p>
                    <p className="text-slate-300 leading-relaxed">{bug.expected_behavior}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-red-400 mb-1">Actual Behavior</p>
                    <p className="text-slate-300 leading-relaxed">{bug.actual_behavior}</p>
                  </div>
                </div>
                <div className="pt-3 border-t border-slate-800">
                  <p className="font-semibold text-slate-200 mb-1">Potential Impact</p>
                  <p className="text-slate-400">{bug.potential_impact}</p>
                </div>
                <div className="pt-3 border-t border-slate-800">
                  <p className="font-semibold text-[#3B82F6] mb-1">Recommended Solution</p>
                  <p className="text-slate-200">{bug.suggested_solution}</p>
                </div>
              </div>
            </div>

            <div className="lg:col-span-6 rounded-xl bg-[#111C2D] border border-slate-800 overflow-hidden flex flex-col">
              <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between text-xs">
                <span className="font-mono text-white">{bug.file_path}</span>
                <span className="text-slate-400">{bug.analyzer_source}</span>
              </div>
              <div className="flex-1 bg-[#080F1D] font-mono text-xs overflow-auto max-h-[560px]">
                {(fileContent || bug.original_code).split('\n').map((line, i) => {
                  const lineNo = i + 1;
                  const highlighted = lineNo >= bug.start_line && lineNo <= bug.end_line;
                  return (
                    <div
                      key={lineNo}
                      className={`flex items-stretch ${
                        highlighted ? 'bg-red-500/15 text-red-100' : 'text-slate-300'
                      }`}
                    >
                      <span className="w-12 shrink-0 text-right pr-3 py-0.5 text-slate-500 select-none tabular-nums border-r border-slate-800/70">
                        {lineNo}
                      </span>
                      <pre className="pl-3 pr-4 py-0.5 whitespace-pre">{line}</pre>
                    </div>
                  );
                })}
              </div>
              <div className="px-5 py-3 border-t border-slate-800 text-xs text-slate-400 font-mono">
                Evidence: {bug.evidence}
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
