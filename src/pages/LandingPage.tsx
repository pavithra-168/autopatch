import {
  ArrowRight,
  CheckCircle2,
  Code2,
  Cpu,
  FlaskConical,
  GitBranch,
  Layers,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.tsx';

const SAMPLE_PREVIEWS = [
  {
    id: 'BUG-001',
    file: 'calculator.py',
    line: 10,
    severity: 'Critical',
    title: 'Division by zero in divide()',
    original: `def divide(a: float, b: float) -> float:\n    return a / b`,
    patched: `def divide(a: float, b: float) -> float:\n    if b == 0:\n        raise ValueError("Divisor 'b' cannot be zero.")\n    return a / b`,
    cause: 'Denominator parameter `b` is passed directly to `/` without a zero check, raising an unhandled ZeroDivisionError on `divide(10, 0)`.',
  },
  {
    id: 'BUG-003',
    file: 'student.py',
    line: 6,
    severity: 'Medium',
    title: "Undefined variable 'final_status'",
    original: `def format_student_summary(name: str, scores: list[int]) -> str:\n    avg_score = sum(scores) / len(scores)\n    return f"{name}: avg={avg_score:.1f}, status={final_status}"`,
    patched: `def format_student_summary(name: str, scores: list[int]) -> str:\n    if not scores:\n        raise ValueError("scores must not be empty")\n    avg_score = sum(scores) / len(scores)\n    final_status = "Pass" if avg_score >= 40 else "Fail"\n    return f"{name}: avg={avg_score:.1f}, status={final_status}"`,
    cause: '`final_status` is referenced inside the formatted string without prior assignment in `format_student_summary`.',
  },
  {
    id: 'BUG-004',
    file: 'sorting.py',
    line: 6,
    severity: 'High',
    title: 'Off-by-one loop condition in find_max()',
    original: `def find_max(items: list[int]) -> int:\n    highest = items[0]\n    for i in range(len(items) + 1):\n        if items[i] > highest:\n            highest = items[i]\n    return highest`,
    patched: `def find_max(items: list[int]) -> int:\n    if not items:\n        raise ValueError("items cannot be empty")\n    highest = items[0]\n    for item in items[1:]:\n        if item > highest:\n            highest = item\n    return highest`,
    cause: '`range(len(items) + 1)` iterates past the final 0-based index `len(items) - 1`, triggering an IndexError.',
  },
];

export function LandingPage() {
  const { user } = useAuth();
  const [selectedSample, setSelectedSample] = useState(0);
  const [imgError, setImgError] = useState(false);
  const active = SAMPLE_PREVIEWS[selectedSample];

  return (
    <div className="min-h-screen bg-[#080F1D] text-slate-100">
      {/* 3-Zone Top Bar */}
      <header className="border-b border-slate-800/80 bg-[#080F1D]/90 backdrop-blur sticky top-0 z-30">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10 h-16 flex items-center justify-between gap-8">
          <Link
            to="/"
            className="text-lg font-display font-bold tracking-tight text-white whitespace-nowrap shrink-0 flex items-center gap-2"
          >
            <ShieldCheck className="w-5 h-5 text-[#3B82F6]" />
            <span>AutoPatch</span>
          </Link>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400">
            <a href="#how-it-works" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              How It Works
            </a>
            <a href="#capabilities" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Capabilities
            </a>
            <a href="#preview" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Live Preview
            </a>
            <a href="#benefits" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
              Benefits
            </a>
          </nav>

          <div className="shrink-0">
            <Link
              to={user ? '/dashboard' : '/register'}
              className="px-4 py-2 text-sm font-medium text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
            >
              <span>{user ? 'Open Console' : 'Get Started'}</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="max-w-[1440px] mx-auto px-6 lg:px-10 py-16 lg:py-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-center">
            <p className="text-sm font-medium text-[#D5AD60] mb-4">
              Autonomous Static Analysis & Sandboxed Repair
            </p>
            <h1 className="font-display font-bold text-white tracking-tight leading-[1.08] text-[clamp(2.25rem,4vw,3.75rem)] [text-wrap:balance]">
              Find Bugs. Understand Them. Fix Them.
            </h1>
            <p className="mt-6 text-base sm:text-lg text-slate-300 leading-relaxed max-w-xl">
              AutoPatch inspects uploaded source archives and GitHub repositories with Python AST static analysis, explains root causes in plain engineering prose, proposes reviewable patches, and verifies every fix inside an isolated test sandbox.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                to={user ? '/upload' : '/register'}
                className="px-6 py-3 text-sm font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-lg transition-colors whitespace-nowrap inline-flex items-center gap-2"
              >
                <span>Get Started</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
              <a
                href="#capabilities"
                className="px-6 py-3 text-sm font-semibold text-slate-200 bg-[#111C2D] border border-slate-700 hover:border-slate-500 rounded-lg transition-colors whitespace-nowrap"
              >
                Explore Features
              </a>
              {!user && (
                <Link
                  to="/login"
                  className="px-4 py-3 text-sm font-medium text-slate-400 hover:text-white transition-colors whitespace-nowrap"
                >
                  Sign In
                </Link>
              )}
            </div>
          </div>

          <div className="lg:col-span-6 flex">
            <div className="w-full rounded-xl overflow-hidden border border-slate-800 bg-[#111C2D] min-h-[320px] flex items-center justify-center">
              {!imgError ? (
                <img
                  src="/src/assets/images/hero_code_inspector_1795083113580.jpg"
                  alt="AutoPatch isometric static analysis and automated repair pipeline"
                  referrerPolicy="no-referrer"
                  onError={() => setImgError(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="p-10 text-center">
                  <Cpu className="w-12 h-12 text-[#3B82F6] mx-auto mb-3" />
                  <p className="text-sm font-medium text-slate-200">
                    Static AST Inspection · Gemini Root-Cause Engine · Isolated Test Sandbox
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="border-t border-slate-800/80 bg-[#111C2D]/40 py-16 lg:py-20">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
          <div className="max-w-2xl mb-12">
            <h2 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight">
              End-to-End Repair Workflow
            </h2>
            <p className="mt-3 text-slate-400">
              Every defect moves from automated discovery to developer-approved verification without mutating source files unreviewed.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              {
                num: '01. Project Ingestion',
                title: 'Upload ZIP or Clone GitHub',
                desc: 'Extract archives with path-traversal protection or clone public repositories into isolated workspace storage.',
              },
              {
                num: '02. Multi-Stage Scan',
                title: 'AST & Security Inspection',
                desc: 'Walk Python syntax trees for undefined symbols, zero division, off-by-one loops, and dangerous dynamic calls.',
              },
              {
                num: '03. Root-Cause & Patch',
                title: 'Diagnose & Generate Diff',
                desc: 'Inspect triggering conditions and side-by-side diffs before approving or rejecting candidate repairs.',
              },
              {
                num: '04. Sandbox Validation',
                title: 'Regression Test Execution',
                desc: 'Run before-fix vs after-fix unit and edge-case checks in isolated temp sandboxes with instant rollback.',
              },
            ].map((step) => (
              <div key={step.num} className="p-6 rounded-xl bg-[#111C2D] border border-slate-800">
                <p className="text-xs font-mono text-[#D5AD60] mb-2">{step.num}</p>
                <h3 className="text-base font-display font-semibold text-white mb-2">{step.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Core Capabilities Bento Grid */}
      <section id="capabilities" className="max-w-[1440px] mx-auto px-6 lg:px-10 py-16 lg:py-20">
        <div className="max-w-2xl mb-12">
          <h2 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight">
            Built for Verification, Not Guesswork
          </h2>
          <p className="mt-3 text-slate-400">
            Static evidence, human approval gates, and immutable backups protect your repository at every step.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 p-7 rounded-xl bg-[#111C2D] border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2.5 text-[#3B82F6] mb-3">
                <Code2 className="w-5 h-5" />
                <span className="text-sm font-semibold">Python 3.11 AST & Security Engine</span>
              </div>
              <h3 className="text-xl font-display font-semibold text-white">
                Line-Accurate Defect Detection with Evidence
              </h3>
              <p className="mt-2 text-sm text-slate-400 max-w-2xl leading-relaxed">
                Every reported issue captures the exact file path, line span, AST evidence, triggering input condition, expected behavior, and confidence rating—separating proven static defects from potential runtime hazards.
              </p>
            </div>
            <div className="mt-6 pt-5 border-t border-slate-800 flex flex-wrap gap-6 text-xs text-slate-300 font-mono">
              <span>Undefined Names</span>
              <span className="text-slate-600">·</span>
              <span>Division by Zero</span>
              <span className="text-slate-600">·</span>
              <span>Off-by-One Loops</span>
              <span className="text-slate-600">·</span>
              <span>Unsafe eval() / shell=True</span>
            </div>
          </div>

          <div className="p-7 rounded-xl bg-[#111C2D] border border-slate-800">
            <div className="flex items-center gap-2.5 text-[#D5AD60] mb-3">
              <GitBranch className="w-5 h-5" />
              <span className="text-sm font-semibold">Safe Branch & Backup Control</span>
            </div>
            <h3 className="text-xl font-display font-semibold text-white">
              Immutable Backups & Rollback
            </h3>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              Source files are hashed before patch application. Originals are archived before modification, Git repairs isolate onto dedicated branches, and any patch can be rolled back in one click.
            </p>
          </div>

          <div className="p-7 rounded-xl bg-[#111C2D] border border-slate-800">
            <div className="flex items-center gap-2.5 text-emerald-400 mb-3">
              <FlaskConical className="w-5 h-5" />
              <span className="text-sm font-semibold">Sandboxed Test Matrix</span>
            </div>
            <h3 className="text-xl font-display font-semibold text-white">
              Before-Fix vs After-Fix Proof
            </h3>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              AutoPatch executes project unit tests alongside edge-case probes against both the original and patched snapshots in isolated temporary sandboxes.
            </p>
          </div>

          <div className="lg:col-span-2 p-7 rounded-xl bg-[#111C2D] border border-slate-800">
            <div className="flex items-center gap-2.5 text-[#3B82F6] mb-3">
              <Layers className="w-5 h-5" />
              <span className="text-sm font-semibold">Side-by-Side Diff Inspection & Audit Trail</span>
            </div>
            <h3 className="text-xl font-display font-semibold text-white">
              Review Every Modified Line Before Execution
            </h3>
            <p className="mt-2 text-sm text-slate-400 max-w-2xl leading-relaxed">
              Switch effortlessly between split side-by-side and unified diffs with line numbers, deleted/added highlighting, full change history, and downloadable JSON or Markdown validation reports.
            </p>
          </div>
        </div>
      </section>

      {/* Sample Bug Detection Preview */}
      <section id="preview" className="border-t border-slate-800/80 bg-[#111C2D]/40 py-16 lg:py-20">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
            <div>
              <h2 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight">
                Interactive Repair Preview
              </h2>
              <p className="mt-2 text-slate-400 text-sm">
                Inspect how AutoPatch pairs AST findings with root-cause explanations and verifiable patches.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5 bg-[#080F1D] p-1 rounded-lg border border-slate-800">
              {SAMPLE_PREVIEWS.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedSample(idx)}
                  className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors whitespace-nowrap ${
                    selectedSample === idx
                      ? 'bg-[#3B82F6] text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {s.id} · {s.file}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#080F1D] overflow-hidden">
            <div className="px-5 py-3.5 bg-[#111C2D] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 text-sm">
                <ShieldAlert className="w-4 h-4 text-[#D5AD60]" />
                <span className="font-semibold text-white">{active.title}</span>
                <span className="text-slate-600">·</span>
                <span className="font-mono text-xs text-slate-400">
                  {active.file}:{active.line}
                </span>
                <span className="text-slate-600">·</span>
                <span className="text-xs font-medium text-[#D5AD60]">{active.severity}</span>
              </div>
              <Link
                to="/register"
                className="text-xs font-medium text-[#3B82F6] hover:underline whitespace-nowrap"
              >
                Run on your repository →
              </Link>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-800 font-mono text-xs">
              <div className="p-5">
                <p className="text-[11px] uppercase tracking-wider text-red-400 mb-3">Original Code</p>
                <pre className="text-slate-300 overflow-x-auto leading-relaxed">{active.original}</pre>
              </div>
              <div className="p-5">
                <p className="text-[11px] uppercase tracking-wider text-emerald-400 mb-3">Suggested Patch</p>
                <pre className="text-emerald-200 overflow-x-auto leading-relaxed">{active.patched}</pre>
              </div>
            </div>
            <div className="px-5 py-3.5 bg-[#111C2D]/60 border-t border-slate-800 text-xs text-slate-300">
              <span className="font-semibold text-white mr-2">Root Cause:</span>
              {active.cause}
            </div>
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section id="benefits" className="max-w-[1440px] mx-auto px-6 lg:px-10 py-16 lg:py-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
          <div className="lg:col-span-5">
            <h2 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight">
              Why Engineering Teams Adopt AutoPatch
            </h2>
            <p className="mt-3 text-slate-400 text-sm leading-relaxed">
              Reduce triage cycles while keeping senior engineers in complete control of every commit and rollback.
            </p>
          </div>
          <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-6">
            {[
              'Zero unreviewed writes — developers approve every diff explicitly.',
              'Sandboxed before/after regression tests verify repairs objectively.',
              'Complete audit history with one-click backup restoration.',
              'Exportable Markdown & JSON audit reports for engineering reviews.',
            ].map((item) => (
              <div key={item} className="flex items-start gap-3 p-4 rounded-lg bg-[#111C2D] border border-slate-800">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <p className="text-sm text-slate-200">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-800/80 py-8 px-6 lg:px-10">
        <div className="max-w-[1440px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-2 text-slate-300 font-medium">
            <ShieldCheck className="w-4 h-4 text-[#3B82F6]" />
            <span>AutoPatch</span>
            <span className="text-slate-600">·</span>
            <span>Autonomous Software Bug Detection & Repair</span>
          </div>
          <div className="flex items-center gap-6">
            <Link to="/login" className="hover:text-slate-300">
              Sign In
            </Link>
            <Link to="/register" className="hover:text-slate-300">
              Create Account
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
