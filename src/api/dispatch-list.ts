import { CHAINS, type Chain } from '../domain/chain.js';
import { err, ok, type Result } from '../domain/result.js';
import type {
  DispatchCursor,
  DispatchListQuery,
  DispatchStore,
} from '../repository/dispatch-store.js';
import { summarizeDispatch } from './dispatch-view.js';

/** Every top-level status a listed row can have, Managed (`partial`) or Relay (`abandoned`). */
const LIST_STATUSES = [
  'queued',
  'broadcasting',
  'confirmed',
  'failed',
  'partial',
  'abandoned',
  'cancelled',
] as const;
type ListStatus = (typeof LIST_STATUSES)[number];

export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;

/** `GET /v1/dispatches`'s query, as the wire sends it; Fastify's schema has already checked the enums and the limit. */
export type RawListQuery = {
  cursor?: string;
  limit?: number;
  chain?: Chain;
  mode?: 'managed' | 'relay';
  status?: ListStatus;
  from?: string;
  to?: string;
};

export const listQuerySchema = {
  type: 'object',
  properties: {
    cursor: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
    chain: { type: 'string', enum: CHAINS },
    mode: { type: 'string', enum: ['managed', 'relay'] },
    status: { type: 'string', enum: LIST_STATUSES },
    from: { type: 'string' },
    to: { type: 'string' },
  },
};

export type DispatchListFilter = Omit<DispatchListQuery, 'after' | 'storedStatuses'> & {
  cursor: DispatchCursor | null;
  status?: ListStatus;
};

const EXACT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(cursor: DispatchCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString('base64url');
}

function decodeCursor(raw: string): DispatchCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed as unknown[];
    if (typeof createdAt !== 'string' || !EXACT_UTC.test(createdAt)) return null;
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function parseTime(raw: string | undefined, name: string): Result<Date | undefined, string> {
  if (raw === undefined) return ok(undefined);
  const time = new Date(raw);
  return Number.isNaN(time.getTime()) ? err(`${name} must be an ISO 8601 timestamp`) : ok(time);
}

export function parseListQuery(raw: RawListQuery): Result<DispatchListFilter, string> {
  const cursor = raw.cursor === undefined ? null : decodeCursor(raw.cursor);
  if (cursor === null && raw.cursor !== undefined) return err('cursor is not one this API issued');
  const from = parseTime(raw.from, 'from');
  if (!from.ok) return from;
  const to = parseTime(raw.to, 'to');
  if (!to.ok) return to;
  return ok({
    cursor,
    limit: raw.limit ?? DEFAULT_LIST_LIMIT,
    ...(raw.chain ? { chain: raw.chain } : {}),
    ...(raw.mode ? { mode: raw.mode } : {}),
    ...(raw.status ? { status: raw.status } : {}),
    ...(from.value ? { from: from.value } : {}),
    ...(to.value ? { to: to.value } : {}),
  });
}

/** The stored statuses a row can have and still read as `status`, so the store skips the rest. */
function storedStatusesFor(status: ListStatus): NonNullable<DispatchListQuery['storedStatuses']> {
  switch (status) {
    case 'cancelled':
      return ['cancelled'];
    // A claimed Relay Dispatch reads `queued` until its Transaction is written.
    case 'queued':
      return ['queued', 'broadcasting'];
    default:
      return ['broadcasting'];
  }
}

/**
 * One page of `GET /v1/dispatches`. A status filter is on the derived status,
 * which the store cannot see, so rows are scanned in listing order until the
 * page is full and one more match proves there is a next page. The cursor is
 * the last row returned, so a page never skips or repeats a row.
 */
export async function listDispatchPage(store: DispatchStore, filter: DispatchListFilter) {
  const { cursor, status, ...query } = filter;
  const dispatches: ReturnType<typeof summarizeDispatch>[] = [];
  let lastReturned: DispatchCursor | null = null;
  let after = cursor;
  for (;;) {
    const batch = await store.listDispatches({
      ...query,
      after,
      limit: filter.limit + 1,
      ...(status ? { storedStatuses: storedStatusesFor(status) } : {}),
    });
    for (const listed of batch) {
      const summary = summarizeDispatch(listed);
      if (status && summary.status !== status) continue;
      if (dispatches.length === filter.limit) {
        return { dispatches, nextCursor: lastReturned && encodeCursor(lastReturned) };
      }
      dispatches.push(summary);
      lastReturned = listed.cursor;
    }
    const last = batch.at(-1);
    if (!last || batch.length <= filter.limit) return { dispatches, nextCursor: null };
    after = last.cursor;
  }
}
