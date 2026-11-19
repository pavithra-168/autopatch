import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { RecentTaskItem } from '../types/autopatch.ts';
import { StatusText } from './StatusLabel.tsx';

function getTaskTargetRoute(task: RecentTaskItem): string {
  if (task.task_status === 'Analyzing') {
    return `/analysis?scanId=${task.scan_id}&projectId=${task.project_id}`;
  }
  if (task.task_status === 'Validating') {
    return '/testing';
  }
  if (task.task_status === 'Patching') {
    return `/bugs?projectId=${task.project_id}`;
  }
  return `/bugs?projectId=${task.project_id}`;
}

export function RecentActivityWidget({
  tasks,
  onInspectProject,
}: {
  tasks: RecentTaskItem[];
  onInspectProject?: (projectId: number) => void;
}) {
  const visibleTasks = tasks.slice(0, 3);

  return (
    <section
      aria-label="Recent Activity"
      className="lg:col-span-5 rounded-xl bg-[#111C2D] border border-slate-800 overflow-hidden flex flex-col"
    >
      <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-display font-semibold text-white">Recent Activity</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Latest 3 bug detection tasks
          </p>
        </div>
        <Link to="/history" className="text-xs text-[#3B82F6] hover:underline whitespace-nowrap shrink-0">
          Full Log
        </Link>
      </div>

      {visibleTasks.length === 0 ? (
        <div className="p-8 text-center flex-1 flex flex-col items-center justify-center">
          <p className="text-xs text-slate-400">No bug detection tasks run yet.</p>
          <Link
            to="/upload"
            className="mt-3 text-xs font-medium text-[#3B82F6] hover:underline"
          >
            Start a project scan
          </Link>
        </div>
      ) : (
        <div className="divide-y divide-slate-800/70 flex-1">
          {visibleTasks.map((task) => {
            const targetUrl = getTaskTargetRoute(task);
            return (
              <div
                key={task.scan_id}
                className="px-5 py-4 hover:bg-slate-800/25 transition-colors space-y-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      to={targetUrl}
                      className="text-sm font-medium text-white hover:text-[#3B82F6] transition-colors inline-flex items-center gap-1 max-w-full"
                    >
                      <span className="truncate">{task.project_name}</span>
                      <ArrowUpRight className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                    </Link>
                    <p className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
                      Scan #{task.scan_id} · {task.programming_language} · {task.started_at.slice(0, 16).replace('T', ' ')}
                    </p>
                  </div>

                  <StatusText status={task.task_status} />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-slate-400 font-mono tabular-nums gap-2">
                    <span className="truncate pr-2">{task.current_stage}</span>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="text-slate-300">
                        {task.task_status === 'Analyzing'
                          ? `${task.scanned_files}/${task.total_files} files (${task.progress_percentage}%)`
                          : `${task.total_bugs} bugs · ${task.fixed_bugs} fixed`}
                      </span>
                      {onInspectProject && (
                        <button
                          type="button"
                          onClick={() => onInspectProject(task.project_id)}
                          className="text-[#3B82F6] hover:underline font-sans font-medium"
                        >
                          Inspect Lines
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="h-1.5 rounded bg-[#080F1D] overflow-hidden border border-slate-800/80">
                    <div
                      className={`h-full transition-all duration-300 ${
                        task.task_status === 'Failed'
                          ? 'bg-red-500'
                          : task.task_status === 'Validated' || task.task_status === 'Completed'
                          ? 'bg-emerald-500'
                          : task.task_status === 'Patching'
                          ? 'bg-[#D5AD60]'
                          : 'bg-[#3B82F6]'
                      }`}
                      style={{
                        width: `${
                          task.task_status === 'Analyzing'
                            ? Math.max(8, task.progress_percentage)
                            : 100
                        }%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
