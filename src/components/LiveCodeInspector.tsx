import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  FileCode2,
  GitCompare,
  Loader2,
  Play,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { bugService, patchService, projectService, testService } from '../services/domainServices.ts';
import type { FileDiagnostic, LineDiagnostic, Project, ProjectDiagnostics } from '../types/autopatch.ts';
import { DiffViewer } from './DiffViewer.tsx';

interface LiveCodeInspectorProps {
  diagnostics: ProjectDiagnostics | null;
  projects: Project[];
  selectedProjectId: number | null;
  onSelectProject: (projectId: number) => void;
  sseConnected: boolean;
  lastSyncedAt?: string;
  onRefreshRequested: () => void;
}

export function LiveCodeInspector({
  diagnostics,
  projects,
  selectedProjectId,
  onSelectProject,
  sseConnected,
  lastSyncedAt,
  onRefreshRequested,
}: LiveCodeInspectorProps) {
  const [fileFilter, setFileFilter] = useState<'all' | 'wrong' | 'right'>('all');
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');
  const [viewMode, setViewMode] = useState<'lines' | 'diff'>('lines');
  const [activeErrorIdx, setActiveErrorIdx] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const files = diagnostics?.files ?? [];

  const filteredFiles = useMemo(() => {
    if (fileFilter === 'wrong') return files.filter((f) => f.status === 'wrong');
    if (fileFilter === 'right') return files.filter((f) => f.status !== 'wrong');
    return files;
  }, [files, fileFilter]);

  useEffect(() => {
    if (files.length === 0) {
      setSelectedFilePath('');
      return;
    }
    const stillExists = files.some((f) => f.file_path === selectedFilePath);
    if (!stillExists) {
      const firstWrong = files.find((f) => f.status === 'wrong');
      setSelectedFilePath((firstWrong ?? files[0]).file_path);
      setActiveErrorIdx(0);
    }
  }, [files, selectedFilePath]);

  const activeFile: FileDiagnostic | undefined = useMemo(() => {
    return files.find((f) => f.file_path === selectedFilePath) ?? filteredFiles[0] ?? files[0];
  }, [files, filteredFiles, selectedFilePath]);

  const codeLines = useMemo(() => {
    if (!activeFile) return [];
    if (!activeFile.content) return [''];
    return activeFile.content.replace(/\r\n/g, '\n').split('\n');
  }, [activeFile]);

  const wrongLinesSet = useMemo(() => new Set(activeFile?.wrong_lines ?? []), [activeFile]);
  const rightLinesSet = useMemo(() => new Set(activeFile?.right_lines ?? []), [activeFile]);

  const diagnosticsByEndLine = useMemo(() => {
    const map = new Map<number, LineDiagnostic[]>();
    if (!activeFile) return map;
    for (const d of activeFile.diagnostics) {
      const anchor = Math.max(1, d.end_line || d.start_line || 1);
      const list = map.get(anchor) ?? [];
      list.push(d);
      map.set(anchor, list);
    }
    return map;
  }, [activeFile]);

  const errorJumpLines = useMemo(() => {
    if (!activeFile) return [];
    return activeFile.diagnostics
      .filter((d) => d.is_wrong)
      .map((d) => d.start_line)
      .sort((a, b) => a - b);
  }, [activeFile]);

  const jumpToErrorLine = (nextIdx: number) => {
    if (errorJumpLines.length === 0) return;
    const wrapped = (nextIdx + errorJumpLines.length) % errorJumpLines.length;
    setActiveErrorIdx(wrapped);
    const targetLine = errorJumpLines[wrapped];
    const el = lineRefs.current[targetLine];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleRescan = async () => {
    if (!diagnostics) return;
    setBusyKey('rescan');
    setActionError('');
    setActionNotice('');
    try {
      await projectService.startScan(diagnostics.project.id);
      setActionNotice('Real-time AST scan started. Line indicators will update live.');
      onRefreshRequested();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Unable to start scan.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleGeneratePatch = async (diag: LineDiagnostic) => {
    setBusyKey(`gen-${diag.bug_id}`);
    setActionError('');
    setActionNotice('');
    try {
      await bugService.analyzeWithAI(diag.bug_id).catch(() => null);
      await patchService.generate(diag.bug_id);
      setActionNotice(`Generated candidate fix for ${diag.bug_code}. Inspect Wrong vs Right diff.`);
      setViewMode('diff');
      onRefreshRequested();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Patch generation failed.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleApplyAndValidate = async (diag: LineDiagnostic) => {
    if (!diag.latest_patch) return;
    const patchId = diag.latest_patch.id;
    setBusyKey(`apply-${patchId}`);
    setActionError('');
    setActionNotice('');
    try {
      if (diag.latest_patch.patch_status === 'Pending Approval') {
        await patchService.approve(patchId);
      }
      if (diag.latest_patch.patch_status !== 'Applied') {
        await patchService.apply(patchId);
      }
      const testRes = await testService.run(patchId);
      setActionNotice(
        `Applied patch #${patchId} & ran sandbox tests: ${testRes.after.passed}/${testRes.after.total_tests} passed (${testRes.validation_status}).`
      );
      onRefreshRequested();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to apply and validate patch.');
    } finally {
      setBusyKey(null);
    }
  };

  const scanRunning = diagnostics?.latest_scan?.scan_status === 'Running';
  const summary = diagnostics?.summary;
  const activePatchDiag = useMemo(() => {
    if (!activeFile) return undefined;
    return activeFile.diagnostics.find((d) => d.latest_patch) ?? activeFile.diagnostics[0];
  }, [activeFile]);
  const activePatch = activePatchDiag?.latest_patch ?? activeFile?.latest_patch ?? null;

  return (
    <section
      aria-label="Real-Time File and Line Error Inspector"
      className="rounded-xl bg-[#111C2D] border border-slate-800 overflow-hidden"
    >
      {/* Top Workbench Header */}
      <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4 bg-[#0D1627]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-[#080F1D] border border-slate-700/80 flex items-center justify-center shrink-0">
            <Code2 className="w-4 h-4 text-[#3B82F6]" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-display font-semibold text-white">
                Real-Time File & Line Code Inspector
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] font-mono tabular-nums px-2 py-0.5 rounded border ${
                  sseConnected
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-slate-700 bg-[#080F1D] text-slate-400'
                }`}
              >
                {scanRunning ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <span
                    className={`w-1.5 h-1.5 rounded-sm ${
                      sseConnected ? 'bg-emerald-400' : 'bg-slate-500'
                    }`}
                  />
                )}
                <span>{sseConnected ? 'SSE Live Stream' : 'Snapshot Mode'}</span>
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Red lines mark active defects (<span className="text-red-400 font-medium">× Wrong</span>) · Green lines mark verified or fixed code (<span className="text-emerald-400 font-medium">✓ Right</span>)
              {lastSyncedAt ? (
                <span className="text-slate-500 font-mono tabular-nums ml-2">
                  · Synced {lastSyncedAt.slice(11, 19)} UTC
                </span>
              ) : null}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {projects.length > 0 && (
            <select
              aria-label="Inspect project"
              value={selectedProjectId ?? diagnostics?.project.id ?? ''}
              onChange={(e) => onSelectProject(Number(e.target.value))}
              className="px-3 py-1.5 rounded-lg bg-[#080F1D] border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-[#3B82F6]"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.project_name} ({p.programming_language})
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={busyKey === 'rescan' || scanRunning || !diagnostics}
            onClick={handleRescan}
            className="px-3.5 py-1.5 rounded-lg bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-60 text-xs font-semibold text-white inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            {busyKey === 'rescan' || scanRunning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            <span>{scanRunning ? 'Scanning Live...' : 'Run Live Scan'}</span>
          </button>
        </div>
      </div>

      {/* Live Scan Progress Strip when actively running */}
      {scanRunning && diagnostics?.latest_scan && (
        <div className="px-6 py-2.5 bg-[#0A1322] border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-xs text-[#3B82F6] font-mono tabular-nums">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>
              Stage: {diagnostics.latest_scan.current_stage} · {diagnostics.latest_scan.scanned_files}/
              {diagnostics.latest_scan.total_files} files ({diagnostics.latest_scan.progress_percentage}%)
            </span>
          </div>
          <div className="w-56 h-1.5 bg-[#080F1D] rounded overflow-hidden border border-slate-800">
            <div
              className="h-full bg-[#3B82F6] transition-all duration-200"
              style={{ width: `${Math.max(8, diagnostics.latest_scan.progress_percentage)}%` }}
            />
          </div>
        </div>
      )}

      {/* Real Value Summary Strip: Red = Wrong vs Green = Right */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-800 border-b border-slate-800 bg-[#080F1D]/70">
          <div className="px-5 py-3 flex items-center justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-slate-400">Wrong Files (Errors)</p>
              <p className="text-lg font-display font-bold text-red-400 font-mono tabular-nums mt-0.5">
                {summary.wrong_files_count}
              </p>
            </div>
            <span className="inline-flex items-center gap-1 text-xs font-mono text-red-400 bg-red-500/10 border border-red-500/25 px-2 py-0.5 rounded">
              <X className="w-3 h-3" /> Wrong
            </span>
          </div>

          <div className="px-5 py-3 flex items-center justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-slate-400">Right Files (Clean / Fixed)</p>
              <p className="text-lg font-display font-bold text-emerald-400 font-mono tabular-nums mt-0.5">
                {summary.right_files_count}
              </p>
            </div>
            <span className="inline-flex items-center gap-1 text-xs font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 rounded">
              <Check className="w-3 h-3" /> Right
            </span>
          </div>

          <div className="px-5 py-3 flex items-center justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-slate-400">Error Lines Flagged</p>
              <p className="text-lg font-display font-bold text-red-400 font-mono tabular-nums mt-0.5">
                {summary.wrong_lines_count}
              </p>
            </div>
            <span className="text-xs font-mono text-slate-400 tabular-nums">
              {summary.open_bugs_count} open bugs
            </span>
          </div>

          <div className="px-5 py-3 flex items-center justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-slate-400">Validated / Fixed</p>
              <p className="text-lg font-display font-bold text-emerald-400 font-mono tabular-nums mt-0.5">
                {summary.fixed_bugs_count}
              </p>
            </div>
            <span className="text-xs font-mono text-emerald-400/90 tabular-nums">
              {summary.fixed_lines_count} lines right
            </span>
          </div>
        </div>
      )}

      {actionError && (
        <div className="px-6 py-2.5 bg-red-500/10 border-b border-red-500/30 text-xs text-red-300 flex items-center justify-between gap-2">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError('')} className="text-red-400 hover:text-white">
            Dismiss
          </button>
        </div>
      )}
      {actionNotice && (
        <div className="px-6 py-2.5 bg-emerald-500/10 border-b border-emerald-500/30 text-xs text-emerald-300 flex items-center justify-between gap-2">
          <span>{actionNotice}</span>
          <button type="button" onClick={() => setActionNotice('')} className="text-emerald-400 hover:text-white">
            Dismiss
          </button>
        </div>
      )}

      {!diagnostics || files.length === 0 ? (
        <div className="p-10 text-center text-sm text-slate-400">
          Select or scan a project to inspect source files and real-time Red/Green line diagnostics.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[520px]">
          {/* Left File Explorer */}
          <aside className="lg:col-span-4 border-b lg:border-b-0 lg:border-r border-slate-800 bg-[#0B1322] flex flex-col">
            <div className="p-3 border-b border-slate-800 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setFileFilter('all')}
                className={`px-2.5 py-1 text-xs font-mono rounded transition-colors ${
                  fileFilter === 'all'
                    ? 'bg-[#3B82F6] text-white'
                    : 'text-slate-400 hover:text-white bg-[#080F1D]'
                }`}
              >
                All ({files.length})
              </button>
              <button
                type="button"
                onClick={() => setFileFilter('wrong')}
                className={`px-2.5 py-1 text-xs font-mono rounded transition-colors ${
                  fileFilter === 'wrong'
                    ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                    : 'text-red-400/80 hover:text-red-300 bg-[#080F1D]'
                }`}
              >
                × Wrong ({summary?.wrong_files_count ?? 0})
              </button>
              <button
                type="button"
                onClick={() => setFileFilter('right')}
                className={`px-2.5 py-1 text-xs font-mono rounded transition-colors ${
                  fileFilter === 'right'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'text-emerald-400/80 hover:text-emerald-300 bg-[#080F1D]'
                }`}
              >
                ✓ Right ({summary?.right_files_count ?? 0})
              </button>
            </div>

            <div className="divide-y divide-slate-800/60 overflow-y-auto max-h-[540px]">
              {filteredFiles.map((f) => {
                const isSelected = activeFile?.file_path === f.file_path;
                const isWrong = f.status === 'wrong';
                return (
                  <button
                    key={f.file_path}
                    type="button"
                    onClick={() => {
                      setSelectedFilePath(f.file_path);
                      setActiveErrorIdx(0);
                    }}
                    className={`w-full text-left px-4 py-3 transition-colors flex items-start justify-between gap-3 ${
                      isSelected
                        ? isWrong
                          ? 'bg-red-500/12'
                          : 'bg-emerald-500/10'
                        : isWrong
                        ? 'hover:bg-red-500/8'
                        : 'hover:bg-slate-800/35'
                    }`}
                  >
                    <div className="min-w-0 flex items-start gap-2.5">
                      <FileCode2
                        className={`w-4 h-4 mt-0.5 shrink-0 ${
                          isWrong ? 'text-red-400' : 'text-emerald-400'
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-mono font-medium text-white truncate">
                          {f.file_path}
                        </p>
                        <p className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                          {f.programming_language} · {f.line_count} lines
                        </p>
                      </div>
                    </div>

                    {isWrong ? (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-mono tabular-nums text-red-400 bg-red-500/10 border border-red-500/25 px-1.5 py-0.5 rounded">
                        <X className="w-3 h-3" />
                        <span>
                          {f.error_count} {f.error_count === 1 ? 'error' : 'errors'}
                        </span>
                      </span>
                    ) : (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-mono tabular-nums text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-1.5 py-0.5 rounded">
                        <Check className="w-3 h-3" />
                        <span>{f.status === 'right' ? 'Fixed' : 'Right'}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Right Line-by-Line Diagnostic Code Viewport */}
          <div className="lg:col-span-8 flex flex-col bg-[#080F1D]">
            {activeFile && (
              <>
                <div className="px-4 py-3 bg-[#0E1729] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-3 min-w-0">
                    <span className="text-xs font-mono font-semibold text-white truncate">
                      {activeFile.file_path}
                    </span>
                    {activeFile.status === 'wrong' ? (
                      <span className="inline-flex items-center gap-1 text-xs font-mono text-red-400 tabular-nums">
                        <X className="w-3.5 h-3.5" />
                        <span>
                          {activeFile.error_count} Wrong {activeFile.error_count === 1 ? 'Line Issue' : 'Line Issues'} (lines{' '}
                          {activeFile.wrong_lines.join(', ')})
                        </span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-mono text-emerald-400">
                        <Check className="w-3.5 h-3.5" />
                        <span>
                          {activeFile.status === 'right'
                            ? `Right — ${activeFile.fixed_count} Fixed & Verified`
                            : 'Right — 0 Errors Detected'}
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {errorJumpLines.length > 0 && viewMode === 'lines' && (
                      <div className="inline-flex items-center border border-slate-800 rounded bg-[#080F1D]">
                        <button
                          type="button"
                          onClick={() => jumpToErrorLine(activeErrorIdx - 1)}
                          className="px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 inline-flex items-center gap-1"
                          title="Previous error line"
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                          <span>Prev ×</span>
                        </button>
                        <span className="px-2 py-1 text-[11px] font-mono tabular-nums text-slate-400 border-x border-slate-800">
                          {activeErrorIdx + 1}/{errorJumpLines.length}
                        </span>
                        <button
                          type="button"
                          onClick={() => jumpToErrorLine(activeErrorIdx + 1)}
                          className="px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 inline-flex items-center gap-1"
                          title="Next error line"
                        >
                          <span>Next ×</span>
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}

                    <div className="inline-flex items-center bg-[#080F1D] border border-slate-800 rounded p-0.5">
                      <button
                        type="button"
                        onClick={() => setViewMode('lines')}
                        className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                          viewMode === 'lines'
                            ? 'bg-[#3B82F6] text-white'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        Line Errors
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode('diff')}
                        className={`px-2.5 py-1 text-xs font-medium rounded transition-colors inline-flex items-center gap-1 ${
                          viewMode === 'diff'
                            ? 'bg-[#3B82F6] text-white'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        <GitCompare className="w-3 h-3" />
                        <span>Wrong vs Right Diff</span>
                      </button>
                    </div>
                  </div>
                </div>

                {viewMode === 'diff' ? (
                  <div className="p-4 overflow-y-auto max-h-[520px] space-y-4">
                    {activePatch ? (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-lg bg-[#111C2D] border border-slate-800 text-xs">
                          <div className="text-slate-300">
                            <span className="text-red-400 font-medium">Red = Wrong original code</span>
                            <span className="text-slate-500 mx-2">→</span>
                            <span className="text-emerald-400 font-medium">Green = Right repaired code</span>
                            <span className="text-slate-500 ml-3 font-mono">
                              (Patch #{activePatch.id} · {activePatch.patch_status} · {activePatch.validation_status})
                            </span>
                          </div>
                          {activePatchDiag &&
                            activePatchDiag.latest_patch &&
                            activePatch.patch_status !== 'Applied' &&
                            activePatch.patch_status !== 'Rejected' && (
                            <button
                              type="button"
                              disabled={busyKey === `apply-${activePatch.id}`}
                              onClick={() => handleApplyAndValidate(activePatchDiag)}
                              className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold inline-flex items-center gap-1.5"
                            >
                              {busyKey === `apply-${activePatch.id}` ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Check className="w-3.5 h-3.5" />
                              )}
                              <span>Approve, Apply & Validate</span>
                            </button>
                          )}
                        </div>
                        <DiffViewer
                          originalCode={activePatch.original_code}
                          proposedCode={activePatch.proposed_code}
                          filePath={activeFile.file_path}
                        />
                      </>
                    ) : activeFile.diagnostics.some((d) => d.is_wrong) ? (
                      <div className="p-6 rounded-lg bg-[#111C2D] border border-slate-800 text-center space-y-3">
                        <AlertTriangle className="w-8 h-8 text-[#D5AD60] mx-auto" />
                        <h3 className="text-sm font-display font-semibold text-white">
                          No patch generated yet for {activeFile.file_path}
                        </h3>
                        <p className="text-xs text-slate-400 max-w-md mx-auto">
                          Generate an AI patch for the flagged error line to inspect the Red (Wrong) vs Green (Right) side-by-side comparison.
                        </p>
                        {(() => {
                          const firstWrong = activeFile.diagnostics.find((d) => d.is_wrong)!;
                          return (
                            <button
                              type="button"
                              disabled={busyKey === `gen-${firstWrong.bug_id}`}
                              onClick={() => handleGeneratePatch(firstWrong)}
                              className="px-4 py-2 rounded-lg bg-[#3B82F6] hover:bg-[#2563EB] text-xs font-semibold text-white inline-flex items-center gap-1.5"
                            >
                              {busyKey === `gen-${firstWrong.bug_id}` ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Sparkles className="w-3.5 h-3.5" />
                              )}
                              <span>Generate AI Fix for {firstWrong.bug_code} (Line {firstWrong.start_line})</span>
                            </button>
                          );
                        })()}
                      </div>
                    ) : (
                      <div className="p-6 rounded-lg bg-emerald-500/8 border border-emerald-500/25 text-center space-y-2">
                        <Check className="w-7 h-7 text-emerald-400 mx-auto" />
                        <p className="text-sm font-medium text-emerald-300">
                          ✓ Right — {activeFile.file_path} has no wrong lines requiring a diff.
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="overflow-y-auto max-h-[540px] font-mono text-xs divide-y divide-slate-900/60">
                    {activeFile.status !== 'wrong' && (
                      <div className="px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/25 text-emerald-300 flex items-center gap-2">
                        <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span>
                          ✓ Right — All {codeLines.length} lines in {activeFile.file_path} verified with zero active errors.
                        </span>
                      </div>
                    )}

                    {codeLines.map((lineText, idx) => {
                      const lineNum = idx + 1;
                      const isWrongLine = wrongLinesSet.has(lineNum);
                      const isRightLine = !isWrongLine && (rightLinesSet.has(lineNum) || activeFile.status === 'right');
                      const endingDiags = diagnosticsByEndLine.get(lineNum) ?? [];

                      return (
                        <div
                          key={`${activeFile.file_path}:${lineNum}`}
                          ref={(el) => {
                            lineRefs.current[lineNum] = el;
                          }}
                        >
                          <div
                            className={`flex items-stretch min-h-[26px] ${
                              isWrongLine
                                ? 'bg-red-500/15 text-red-100'
                                : isRightLine
                                ? 'bg-emerald-500/12 text-emerald-100'
                                : activeFile.status === 'clean'
                                ? 'hover:bg-emerald-500/5 text-slate-200'
                                : 'hover:bg-slate-900/60 text-slate-300'
                            }`}
                          >
                            {/* Line number gutter */}
                            <span
                              className={`w-12 shrink-0 select-none text-right pr-3 py-1 tabular-nums border-r border-slate-800/80 ${
                                isWrongLine
                                  ? 'text-red-400 font-semibold bg-red-500/10'
                                  : isRightLine
                                  ? 'text-emerald-400 font-semibold bg-emerald-500/10'
                                  : activeFile.status === 'clean'
                                  ? 'text-emerald-500/65'
                                  : 'text-slate-500'
                              }`}
                            >
                              {lineNum}
                            </span>

                            {/* Explicit Wrong / Right indicator */}
                            <span
                              className={`w-20 shrink-0 select-none px-2 py-1 text-[11px] flex items-center gap-1 border-r border-slate-800/70 ${
                                isWrongLine
                                  ? 'text-red-400 font-semibold'
                                  : isRightLine
                                  ? 'text-emerald-400 font-semibold'
                                  : activeFile.status === 'clean'
                                  ? 'text-emerald-500/60'
                                  : 'text-slate-600'
                              }`}
                            >
                              {isWrongLine ? (
                                <>
                                  <X className="w-3 h-3 shrink-0" />
                                  <span>WRONG</span>
                                </>
                              ) : isRightLine ? (
                                <>
                                  <Check className="w-3 h-3 shrink-0" />
                                  <span>RIGHT</span>
                                </>
                              ) : activeFile.status === 'clean' ? (
                                <>
                                  <Check className="w-2.5 h-2.5 shrink-0" />
                                  <span>OK</span>
                                </>
                              ) : (
                                <span>·</span>
                              )}
                            </span>

                            {/* Source Code Text */}
                            <pre className="py-1 px-3 whitespace-pre overflow-x-auto flex-1 leading-relaxed">
                              {lineText || ' '}
                            </pre>
                          </div>

                          {/* Inline Line Error Callouts */}
                          {endingDiags.map((diag) => (
                            <div
                              key={diag.bug_id}
                              className={`px-4 py-3 border-y font-sans ${
                                diag.is_wrong
                                  ? 'bg-[#170D14] border-red-500/35'
                                  : 'bg-[#091A16] border-emerald-500/30'
                              }`}
                            >
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="space-y-1 min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2 text-xs">
                                    <span
                                      className={`font-mono font-semibold inline-flex items-center gap-1 ${
                                        diag.is_wrong ? 'text-red-400' : 'text-emerald-400'
                                      }`}
                                    >
                                      {diag.is_wrong ? (
                                        <X className="w-3.5 h-3.5" />
                                      ) : (
                                        <Check className="w-3.5 h-3.5" />
                                      )}
                                      <span>
                                        {diag.bug_code} · Line {diag.start_line}
                                        {diag.end_line > diag.start_line ? `–${diag.end_line}` : ''}
                                      </span>
                                    </span>
                                    <span className="text-white font-semibold">{diag.bug_title}</span>
                                    <span className="text-[11px] font-mono text-slate-400">
                                      [{diag.severity} · {diag.analyzer_source} · {diag.bug_status}]
                                    </span>
                                  </div>
                                  <p className="text-xs text-slate-300 leading-relaxed">
                                    {diag.root_cause || diag.bug_description}
                                  </p>
                                  {diag.suggested_solution && (
                                    <p className="text-xs text-emerald-300/90">
                                      <span className="font-semibold text-emerald-400">Fix Guidance:</span>{' '}
                                      {diag.suggested_solution}
                                    </p>
                                  )}
                                </div>

                                <div className="flex flex-wrap items-center gap-2 shrink-0">
                                  <Link
                                    to={`/root-cause?bugId=${diag.bug_id}`}
                                    className="px-2.5 py-1 rounded bg-[#111C2D] border border-slate-700 hover:border-slate-500 text-xs text-slate-200 transition-colors"
                                  >
                                    Root Cause
                                  </Link>

                                  {diag.is_wrong && !diag.latest_patch && (
                                    <button
                                      type="button"
                                      disabled={busyKey === `gen-${diag.bug_id}`}
                                      onClick={() => handleGeneratePatch(diag)}
                                      className="px-2.5 py-1 rounded bg-[#3B82F6] hover:bg-[#2563EB] text-xs font-medium text-white inline-flex items-center gap-1"
                                    >
                                      {busyKey === `gen-${diag.bug_id}` ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <Wrench className="w-3 h-3" />
                                      )}
                                      <span>Generate AI Patch</span>
                                    </button>
                                  )}

                                  {diag.latest_patch && (
                                    <>
                                      <Link
                                        to={`/patches?bugId=${diag.bug_id}`}
                                        className="px-2.5 py-1 rounded bg-[#111C2D] border border-[#3B82F6]/40 text-xs text-[#3B82F6] hover:bg-[#3B82F6]/10"
                                      >
                                        Inspect Patch #{diag.latest_patch.id}
                                      </Link>
                                      {diag.is_wrong && diag.latest_patch.patch_status !== 'Rejected' && (
                                        <button
                                          type="button"
                                          disabled={busyKey === `apply-${diag.latest_patch.id}`}
                                          onClick={() => handleApplyAndValidate(diag)}
                                          className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white inline-flex items-center gap-1"
                                        >
                                          {busyKey === `apply-${diag.latest_patch.id}` ? (
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                          ) : (
                                            <Check className="w-3 h-3" />
                                          )}
                                          <span>Apply & Validate</span>
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
