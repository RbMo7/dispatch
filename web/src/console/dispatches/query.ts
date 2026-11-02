import { CHAINS, type Chain } from '../../domain/chains';
import { type DayRange, parseDay, presetRange } from '../../domain/dateRange';
import type { ItemFilter, ItemStatus, Mode } from '../../domain/dispatch';
import type { Status } from '../../domain/status';
import type { ListFilters } from '../api/client';
import { PANE_TABS, type PaneTab } from './DispatchPane';

/** The statuses `GET /v1/dispatches?status=` accepts. */
export const LIST_STATUSES = [
  'queued',
  'broadcasting',
  'confirmed',
  'partial',
  'failed',
  'abandoned',
  'cancelled',
] as const satisfies readonly Status[];

export type ListStatus = (typeof LIST_STATUSES)[number];

const ITEM_FILTERS: readonly ItemFilter[] = [
  'all',
  'queued',
  'awaiting_approval',
  'broadcasting',
  'confirmed',
  'failed',
  'abandoned',
  'cancelled',
] satisfies readonly ('all' | ItemStatus)[];

/** Everything the Dispatches page keeps in its URL, so any state can be linked. */
export interface DispatchesQuery {
  range: DayRange;
  chain: Chain | 'all';
  /** A Sender's name, or null for every Sender. */
  sender: string | null;
  status: ListStatus | 'all';
  mode: Mode | 'all';
  search: string;
  selected: string | null;
  tab: PaneTab;
  items: ItemFilter;
}

function pick<T extends string>(value: string | null, options: readonly T[], fallback: T): T {
  return value !== null && options.includes(value as T) ? (value as T) : fallback;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The senders file's rule for a name. */
const SENDER_NAME = /^[a-z0-9-]{1,40}$/;

export function readQuery(params: URLSearchParams, today: Date): DispatchesQuery {
  const from = params.get('from');
  const to = params.get('to');
  const sender = params.get('sender');
  return {
    range:
      from && to && DAY.test(from) && DAY.test(to) && from <= to
        ? { from, to }
        : presetRange('30d', today),
    chain: pick(params.get('chain'), ['all', ...(Object.keys(CHAINS) as Chain[])], 'all'),
    sender: sender && SENDER_NAME.test(sender) ? sender : null,
    status: pick(params.get('status'), ['all', ...LIST_STATUSES], 'all'),
    mode: pick(params.get('mode'), ['all', 'managed', 'relay'] as const, 'all'),
    search: params.get('q') ?? '',
    selected: params.get('dispatch'),
    tab: pick(params.get('tab'), PANE_TABS, 'flow'),
    items: pick(params.get('items'), ITEM_FILTERS, 'all'),
  };
}

export function writeQuery(query: DispatchesQuery): URLSearchParams {
  const params = new URLSearchParams({ from: query.range.from, to: query.range.to });
  if (query.chain !== 'all') params.set('chain', query.chain);
  if (query.sender) params.set('sender', query.sender);
  if (query.status !== 'all') params.set('status', query.status);
  if (query.mode !== 'all') params.set('mode', query.mode);
  if (query.search) params.set('q', query.search);
  if (query.selected) {
    params.set('dispatch', query.selected);
    if (query.tab !== 'flow') params.set('tab', query.tab);
    if (query.items !== 'all') params.set('items', query.items);
  }
  return params;
}

/** The API filters: whole local days, `from` inclusive and `to` exclusive at the next midnight. */
export function listFilters(query: DispatchesQuery): ListFilters {
  const end = parseDay(query.range.to);
  return {
    from: parseDay(query.range.from),
    to: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1),
    ...(query.chain !== 'all' && { chain: query.chain }),
    ...(query.sender && { sender: query.sender }),
    ...(query.status !== 'all' && { status: query.status }),
    ...(query.mode !== 'all' && { mode: query.mode }),
  };
}

/** What identifies one list: a change here starts the list over. */
export function listKey(query: DispatchesQuery): string {
  return [
    query.range.from,
    query.range.to,
    query.chain,
    query.sender ?? '',
    query.status,
    query.mode,
  ].join('|');
}
