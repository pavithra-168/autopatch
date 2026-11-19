import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FlaskConical,
  Info,
  Loader2,
  ShieldAlert,
  Wrench,
  XCircle,
} from 'lucide-react';

export function SeverityText({ severity }: { severity: string }) {
  const map: Record<string, { color: string; Icon: typeof AlertOctagon }> = {
    Critical: { color: 'text-red-400', Icon: AlertOctagon },
    High: { color: 'text-[#D5AD60]', Icon: ShieldAlert },
    Medium: { color: 'text-blue-400', Icon: AlertTriangle },
    Low: { color: 'text-slate-400', Icon: Info },
  };
  const cfg = map[severity] || map.Medium;
  const Icon = cfg.Icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${cfg.color}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span>{severity}</span>
    </span>
  );
}

export function StatusText({ status }: { status: string }) {
  const normalized = status || 'Open';
  let color = 'text-slate-300';
  let Icon = Clock;
  let spin = false;

  if (['Fixed', 'Passed', 'Tests Passed', 'Completed', 'Approved', 'Applied', 'Validated'].includes(normalized)) {
    color = 'text-emerald-400';
    Icon = CheckCircle2;
  } else if (['Failed', 'Tests Failed', 'Rejected', 'Error'].includes(normalized)) {
    color = 'text-red-400';
    Icon = XCircle;
  } else if (['Open', 'Pending Approval', 'Validation Incomplete', 'Pending'].includes(normalized)) {
    color = 'text-[#D5AD60]';
    Icon = AlertTriangle;
  } else if (normalized === 'Analyzing') {
    color = 'text-[#3B82F6]';
    Icon = Loader2;
    spin = true;
  } else if (normalized === 'Patching') {
    color = 'text-[#D5AD60]';
    Icon = Wrench;
  } else if (normalized === 'Validating') {
    color = 'text-[#3B82F6]';
    Icon = FlaskConical;
  } else if (['Running', 'Scanning', 'Patched', 'In Review'].includes(normalized)) {
    color = 'text-[#3B82F6]';
    Icon = Clock;
  }

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${color}`}>
      <Icon className={`w-3.5 h-3.5 shrink-0 ${spin ? 'animate-spin' : ''}`} />
      <span>{normalized}</span>
    </span>
  );
}
