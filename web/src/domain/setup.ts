import type { Chain } from './chains';
import type { Status } from './status';

export const AREAS = [
  'configuration',
  'database',
  'chain',
  'signer',
  'sender',
  'multisig',
  'console',
] as const;
export type Area = (typeof AREAS)[number];

export const AREA_LABEL: Record<Area, string> = {
  configuration: 'Configuration',
  database: 'Database',
  chain: 'Chain',
  signer: 'Signer',
  sender: 'Sender',
  multisig: 'Multisig',
  console: 'Console',
};

export type CheckStatus = 'pass' | 'warn' | 'fail';

/** Each check status reads as a word, on the tint of the Dispatch status it is closest to. */
export const CHECK_STATUS: Record<CheckStatus, { label: string; tone: Status }> = {
  pass: { label: 'Pass', tone: 'confirmed' },
  warn: { label: 'Warning', tone: 'partial' },
  fail: { label: 'Problem', tone: 'failed' },
};

/** What to do about a warning or a problem: a command, a setting, or a step outside the server. */
export type Fix = { command: string } | { setting: string; value: string } | { step: string };

export interface SetupCheck {
  id: string;
  area: Area;
  title: string;
  chain: Chain | null;
  ranIn: 'worker' | 'api';
  ranAt: Date;
  status: CheckStatus;
  finding: string;
  fix: Fix | null;
}

export type WorkerRun =
  { status: 'not_run_yet' } | { status: 'ran'; ranAt: Date } | { status: 'unreadable' };

export interface Setup {
  worker: WorkerRun;
  checks: SetupCheck[];
}

/** The worker runs its checks every five minutes; three missed runs means it has likely stopped. */
export const WORKER_STALE_MS = 15 * 60_000;

export interface SetupState {
  passed: number;
  warnings: SetupCheck[];
  problems: SetupCheck[];
  /** The worker's last run is older than three of its runs. */
  workerStale: boolean;
  /** Everything the summary counts as needing the operator. */
  needsYou: number;
}

export function setupState(setup: Setup, now: Date): SetupState {
  const of = (status: CheckStatus) => setup.checks.filter((check) => check.status === status);
  const workerStale =
    setup.worker.status === 'ran' && now.getTime() - setup.worker.ranAt.getTime() > WORKER_STALE_MS;
  const warnings = of('warn');
  const problems = of('fail');
  return {
    passed: of('pass').length,
    warnings,
    problems,
    workerStale,
    needsYou: warnings.length + problems.length + (workerStale ? 1 : 0),
  };
}

/** The checks of each area that has any, in report order. */
export function byArea(checks: readonly SetupCheck[]): { area: Area; checks: SetupCheck[] }[] {
  return AREAS.flatMap((area) => {
    const inArea = checks.filter((check) => check.area === area);
    return inArea.length > 0 ? [{ area, checks: inArea }] : [];
  });
}

export function ago(at: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
