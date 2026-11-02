import { type DispatchSummary, inFlight, type ManagedDetail } from '../../domain/dispatch';
import type { Status } from '../../domain/status';
import { type ApiClient, type ListFilters, PAGE_LIMIT } from '../api/client';

export const RANGES = [
  { value: '1h', label: '1H', ms: 3_600_000 },
  { value: '24h', label: '24H', ms: 86_400_000 },
  { value: '7d', label: '7D', ms: 7 * 86_400_000 },
] as const;

export type Range = (typeof RANGES)[number]['value'];

/** A list walk stops after this many requests; the Overview then says "at least". */
const MAX_PAGES = 30;
/** Dispatches whose details are read to find approvals and abandoned items. */
const MAX_DETAILS = 20;

export interface Walk {
  rows: DispatchSummary[];
  complete: boolean;
}

export async function walk(
  api: ApiClient,
  filters: ListFilters,
  signal: AbortSignal,
): Promise<Walk> {
  const rows: DispatchSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await api.listDispatches(filters, { cursor, limit: PAGE_LIMIT }, signal);
    rows.push(...result.dispatches);
    cursor = result.nextCursor;
    if (!cursor) return { rows, complete: true };
  }
  return { rows, complete: false };
}

/** What is in flight now, and the newest Dispatches: polled every 2 s while anything moves. */
export interface Pulse {
  queued: Walk;
  broadcasting: Walk;
  recent: DispatchSummary[];
}

export async function loadPulse(api: ApiClient, signal: AbortSignal): Promise<Pulse> {
  const [queued, broadcasting, recent] = await Promise.all([
    walk(api, { status: 'queued' }, signal),
    walk(api, { status: 'broadcasting' }, signal),
    api.listDispatches({}, { limit: 5 }, signal),
  ]);
  return { queued, broadcasting, recent: recent.dispatches };
}

export function pulseInFlight(pulse: Pulse): boolean {
  return (
    pulse.queued.rows.length + pulse.broadcasting.rows.length > 0 ||
    pulse.recent.some((row) => inFlight(row.status))
  );
}

export interface Attention {
  /** Dispatches with items inside a Proposal nobody has decided on yet. */
  awaiting: { summary: DispatchSummary; items: number }[];
  /** Dispatches with abandoned items in the last 7 days: no answer, may still land. */
  abandoned: { summary: DispatchSummary; items: number }[];
}

/** History for the chart and what needs an operator: polled every 15 s. */
export interface History {
  since: Date;
  rows: Walk;
  attention: Attention;
}

const WEEK = 7 * 86_400_000;

/**
 * Two of the chosen range (this one and the one before it, for the pace line),
 * and at least the last 24 hours for "settled today". Approvals and abandoned
 * items are only in Dispatch details, so a few of those are read too.
 */
export async function loadHistory(
  api: ApiClient,
  range: Range,
  now: Date,
  signal: AbortSignal,
): Promise<History> {
  const span = RANGES.find((r) => r.value === range)!.ms;
  const since = new Date(now.getTime() - Math.max(2 * span, WEEK));
  const rows = await walk(api, { from: since }, signal);
  const recentWeek = rows.rows.filter((row) => now.getTime() - row.createdAt.getTime() <= WEEK);

  const candidates = (statuses: readonly Status[]) =>
    recentWeek
      .filter((row) => row.mode === 'managed' && statuses.includes(row.status))
      .slice(0, MAX_DETAILS);
  const details = async (summaries: DispatchSummary[]) =>
    Promise.all(
      summaries.map(async (summary) => ({
        summary,
        detail: (await api.getDispatch(summary.id, signal)) as ManagedDetail,
      })),
    );
  const [open, ended] = await Promise.all([
    details(candidates(['broadcasting'])),
    details(candidates(['failed', 'partial'])),
  ]);
  const counted = (
    loaded: { summary: DispatchSummary; detail: ManagedDetail }[],
    status: 'awaiting_approval' | 'abandoned',
  ) =>
    loaded.flatMap(({ summary, detail }) => {
      const items = detail.items.filter((item) => item.status === status).length;
      return items > 0 ? [{ summary, items }] : [];
    });

  return {
    since,
    rows,
    attention: {
      awaiting: counted(open, 'awaiting_approval'),
      abandoned: [
        ...counted(ended, 'abandoned'),
        ...recentWeek
          .filter((row) => row.mode === 'relay' && row.status === 'abandoned')
          .map((summary) => ({ summary, items: 1 })),
      ],
    },
  };
}

export interface Series {
  /** Cumulative Dispatches created, per bucket, this range and the one before. */
  current: number[];
  previous: number[];
  created: number;
  byStatus: Map<Status, number>;
}

const BUCKETS = 24;

/** Pure: the chart's two cumulative lines and the range's count by status. */
export function series(rows: readonly DispatchSummary[], range: Range, now: Date): Series {
  const span = RANGES.find((r) => r.value === range)!.ms;
  const size = span / BUCKETS;
  const current = new Array<number>(BUCKETS).fill(0);
  const previous = new Array<number>(BUCKETS).fill(0);
  const byStatus = new Map<Status, number>();
  let created = 0;
  for (const row of rows) {
    const age = now.getTime() - row.createdAt.getTime();
    if (age < 0) continue;
    if (age < span) {
      current[Math.min(BUCKETS - 1, Math.floor((span - age) / size))]! += 1;
      created += 1;
      byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    } else if (age < 2 * span) {
      previous[Math.min(BUCKETS - 1, Math.floor((2 * span - age) / size))]! += 1;
    }
  }
  const accumulate = (values: number[]) => {
    let sum = 0;
    return values.map((v) => (sum += v));
  };
  return { current: accumulate(current), previous: accumulate(previous), created, byStatus };
}

/** Dispatches created since local midnight that have reached a terminal status. */
export function settledToday(rows: readonly DispatchSummary[], now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return rows.filter((row) => row.createdAt.getTime() >= midnight && !inFlight(row.status)).length;
}
