import { diffLines } from 'diff';
import { useMemo, useState } from 'react';

interface DiffViewerProps {
  originalCode: string;
  proposedCode: string;
  filePath: string;
}

interface DiffRow {
  leftNum: number | null;
  leftText: string;
  leftType: 'unchanged' | 'removed' | 'empty';
  rightNum: number | null;
  rightText: string;
  rightType: 'unchanged' | 'added' | 'empty';
}

export function DiffViewer({ originalCode, proposedCode, filePath }: DiffViewerProps) {
  const [mode, setMode] = useState<'split' | 'unified'>('split');

  const { rows, stats } = useMemo(() => {
    const parts = diffLines(originalCode, proposedCode);
    const computedRows: DiffRow[] = [];
    let leftLine = 1;
    let rightLine = 1;
    let added = 0;
    let removed = 0;

    let i = 0;
    while (i < parts.length) {
      const curr = parts[i];
      const next = parts[i + 1];

      if (curr.removed && next && next.added) {
        const remLines = curr.value.replace(/\n$/, '').split('\n');
        const addLines = next.value.replace(/\n$/, '').split('\n');
        const maxLen = Math.max(remLines.length, addLines.length);
        removed += remLines.length;
        added += addLines.length;

        for (let k = 0; k < maxLen; k++) {
          const hasRem = k < remLines.length;
          const hasAdd = k < addLines.length;
          computedRows.push({
            leftNum: hasRem ? leftLine++ : null,
            leftText: hasRem ? remLines[k] : '',
            leftType: hasRem ? 'removed' : 'empty',
            rightNum: hasAdd ? rightLine++ : null,
            rightText: hasAdd ? addLines[k] : '',
            rightType: hasAdd ? 'added' : 'empty',
          });
        }
        i += 2;
        continue;
      }

      const lines = curr.value.replace(/\n$/, '').split('\n');
      if (curr.value === '') {
        i += 1;
        continue;
      }

      if (curr.removed) {
        removed += lines.length;
        for (const l of lines) {
          computedRows.push({
            leftNum: leftLine++,
            leftText: l,
            leftType: 'removed',
            rightNum: null,
            rightText: '',
            rightType: 'empty',
          });
        }
      } else if (curr.added) {
        added += lines.length;
        for (const l of lines) {
          computedRows.push({
            leftNum: null,
            leftText: '',
            leftType: 'empty',
            rightNum: rightLine++,
            rightText: l,
            rightType: 'added',
          });
        }
      } else {
        for (const l of lines) {
          computedRows.push({
            leftNum: leftLine++,
            leftText: l,
            leftType: 'unchanged',
            rightNum: rightLine++,
            rightText: l,
            rightType: 'unchanged',
          });
        }
      }
      i += 1;
    }

    return { rows: computedRows, stats: { added, removed } };
  }, [originalCode, proposedCode]);

  return (
    <div className="border border-slate-800 rounded-lg overflow-hidden bg-[#080F1D]">
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-2.5 bg-[#111C2D] border-b border-slate-800">
        <div className="flex items-center gap-3 text-xs font-mono">
          <span className="text-slate-200 font-medium">{filePath}</span>
          <span className="text-slate-600">·</span>
          <span className="text-red-400 tabular-nums">-{stats.removed} wrong</span>
          <span className="text-slate-600">·</span>
          <span className="text-emerald-400 tabular-nums">+{stats.added} right</span>
        </div>
        <div className="flex items-center gap-1 bg-[#080F1D] p-1 rounded-md border border-slate-800">
          <button
            type="button"
            onClick={() => setMode('split')}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              mode === 'split'
                ? 'bg-[#3B82F6] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Side-by-Side
          </button>
          <button
            type="button"
            onClick={() => setMode('unified')}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              mode === 'unified'
                ? 'bg-[#3B82F6] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Unified
          </button>
        </div>
      </div>

      {mode === 'split' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-800 font-mono text-xs overflow-x-auto">
          <div>
            <div className="px-4 py-1.5 bg-[#150D14] border-b border-red-500/25 text-[11px] font-medium text-red-400">
              Original Code (× Wrong)
            </div>
            <div className="divide-y divide-slate-900/50">
              {rows.map((r, idx) => (
                <div
                  key={`L-${idx}`}
                  className={`flex items-stretch min-h-[24px] ${
                    r.leftType === 'removed'
                      ? 'bg-red-500/12 text-red-200'
                      : r.leftType === 'empty'
                      ? 'bg-slate-900/40'
                      : 'text-slate-300'
                  }`}
                >
                  <span className="w-11 shrink-0 select-none text-right pr-3 py-0.5 text-slate-500 tabular-nums border-r border-slate-800/60">
                    {r.leftNum ?? ''}
                  </span>
                  <span className="w-5 shrink-0 select-none text-center py-0.5 text-red-400">
                    {r.leftType === 'removed' ? '-' : ''}
                  </span>
                  <pre className="py-0.5 pr-4 whitespace-pre overflow-x-auto flex-1">{r.leftText}</pre>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="px-4 py-1.5 bg-[#091815] border-b border-emerald-500/25 text-[11px] font-medium text-emerald-400">
              Fixed Code (✓ Right)
            </div>
            <div className="divide-y divide-slate-900/50">
              {rows.map((r, idx) => (
                <div
                  key={`R-${idx}`}
                  className={`flex items-stretch min-h-[24px] ${
                    r.rightType === 'added'
                      ? 'bg-emerald-500/12 text-emerald-200'
                      : r.rightType === 'empty'
                      ? 'bg-slate-900/40'
                      : 'text-slate-300'
                  }`}
                >
                  <span className="w-11 shrink-0 select-none text-right pr-3 py-0.5 text-slate-500 tabular-nums border-r border-slate-800/60">
                    {r.rightNum ?? ''}
                  </span>
                  <span className="w-5 shrink-0 select-none text-center py-0.5 text-emerald-400">
                    {r.rightType === 'added' ? '+' : ''}
                  </span>
                  <pre className="py-0.5 pr-4 whitespace-pre overflow-x-auto flex-1">{r.rightText}</pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="font-mono text-xs overflow-x-auto divide-y divide-slate-900/50">
          {rows.flatMap((r, idx) => {
            const out = [];
            if (r.leftType === 'removed') {
              out.push(
                <div key={`UL-${idx}`} className="flex items-stretch bg-red-500/12 text-red-200 min-h-[24px]">
                  <span className="w-11 shrink-0 text-right pr-2 py-0.5 text-slate-500 tabular-nums border-r border-slate-800/60">
                    {r.leftNum}
                  </span>
                  <span className="w-11 shrink-0 text-right pr-2 py-0.5 text-slate-600 tabular-nums border-r border-slate-800/60">
                    -
                  </span>
                  <span className="w-6 text-center py-0.5 text-red-400">-</span>
                  <pre className="py-0.5 pr-4 whitespace-pre flex-1">{r.leftText}</pre>
                </div>
              );
            }
            if (r.rightType === 'added') {
              out.push(
                <div key={`UR-${idx}`} className="flex items-stretch bg-emerald-500/12 text-emerald-200 min-h-[24px]">
                  <span className="w-11 shrink-0 text-right pr-2 py-0.5 text-slate-600 tabular-nums border-r border-slate-800/60">
                    -
                  </span>
                  <span className="w-11 shrink-0 text-right pr-2 py-0.5 text-slate-500 tabular-nums border-r border-slate-800/60">
                    {r.rightNum}
                  </span>
                  <span className="w-6 text-center py-0.5 text-emerald-400">+</span>
                  <pre className="py-0.5 pr-4 whitespace-pre flex-1">{r.rightText}</pre>
                </div>
              );
            }
            if (r.leftType === 'unchanged') {
              out.push(
                <div key={`UU-${idx}`} className="flex items-stretch text-slate-300 min-h-[24px]">
                  <span className="w-11 shrink-0 text-right pr-2 py-0.5 text-slate-500 tabular-nums border-r border-slate-800/60">
                    {r.leftNum}
                  </span>
                  <span className="w-11 shrink-0 text-right pr-2 py-0.5 text-slate-500 tabular-nums border-r border-slate-800/60">
                    {r.rightNum}
                  </span>
                  <span className="w-6 text-center py-0.5 text-slate-600"> </span>
                  <pre className="py-0.5 pr-4 whitespace-pre flex-1">{r.leftText}</pre>
                </div>
              );
            }
            return out;
          })}
        </div>
      )}
    </div>
  );
}
