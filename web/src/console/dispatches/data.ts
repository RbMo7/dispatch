import { useCallback, useRef, useState } from 'react';

import { type DispatchSummary, inFlight, type LoadedDispatch } from '../../domain/dispatch';
import { type ApiClient, ApiError, findSummary, type ListFilters, PAGE_LIMIT } from '../api/client';
import { nextDelay, type Polled, usePoll } from '../live';
import { useApi } from '../session';

interface LoadedPage {
  cursor: string | null;
  ids: string[];
  next: string | null;
}

/** One filtered list as loaded so far: its pages and every row seen, newest first. */
export interface ListSnapshot {
  rows: DispatchSummary[];
  hasMore: boolean;
  inFlight: boolean;
}

interface ListStore {
  key: string;
  pages: LoadedPage[];
  rows: Map<string, DispatchSummary>;
}

function newest(a: DispatchSummary, b: DispatchSummary): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);
}

function snapshot(store: ListStore): ListSnapshot {
  const rows = [...store.rows.values()].sort(newest);
  return {
    rows,
    hasMore: (store.pages.at(-1)?.next ?? null) !== null,
    inFlight: rows.some((row) => inFlight(row.status)),
  };
}

async function fetchPage(
  api: ApiClient,
  filters: ListFilters,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<LoadedPage & { rows: DispatchSummary[] }> {
  const page = await api.listDispatches(filters, { cursor, limit: PAGE_LIMIT }, signal);
  return {
    cursor,
    ids: page.dispatches.map((d) => d.id),
    next: page.nextCursor,
    rows: page.dispatches,
  };
}

/**
 * The Dispatches list with infinite scroll on the API's cursor. Each poll
 * reloads the first page (new Dispatches) and every loaded page holding a row
 * still in flight; rows are merged by id, so nothing is shown twice.
 */
export function useDispatchList(key: string, filters: ListFilters) {
  const api = useApi();
  const store = useRef<ListStore>({ key, pages: [], rows: new Map() });
  if (store.current.key !== key) store.current = { key, pages: [], rows: new Map() };
  const [view, setView] = useState<{ key: string; snap: ListSnapshot } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const load = useCallback(
    async (signal: AbortSignal) => {
      const s = store.current;
      const targets =
        s.pages.length === 0
          ? [null]
          : s.pages.flatMap((page, index) =>
              index === 0 || page.ids.some((id) => inFlight(s.rows.get(id)?.status ?? 'confirmed'))
                ? [index]
                : [],
            );
      const results = await Promise.all(
        targets.map((index) =>
          fetchPage(
            api,
            filtersRef.current,
            index === null ? null : s.pages[index]!.cursor,
            signal,
          ),
        ),
      );
      if (s !== store.current) return snapshot(store.current);
      results.forEach((result, i) => {
        const index = targets[i];
        for (const row of result.rows) s.rows.set(row.id, row);
        if (index === null || index === undefined) s.pages = [result];
        else {
          const last = index === s.pages.length - 1;
          s.pages[index] = { ...result, next: last ? result.next : s.pages[index]!.next };
        }
      });
      const snap = snapshot(s);
      setView({ key: s.key, snap });
      return snap;
    },
    [api],
  );

  const polled = usePoll({
    key,
    load,
    delay: (snap, previous) => nextDelay(snap.inFlight, previous),
  });

  const loadMore = useCallback(async () => {
    const s = store.current;
    const next = s.pages.at(-1)?.next;
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchPage(api, filtersRef.current, next);
      if (s !== store.current) return;
      for (const row of result.rows) s.rows.set(row.id, row);
      s.pages.push(result);
      setView({ key: s.key, snap: snapshot(s) });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    } finally {
      setLoadingMore(false);
    }
  }, [api, loadingMore]);

  const snap = view?.key === key ? view.snap : null;
  return { snap, error: polled.error, loadingMore, loadMore };
}

/**
 * One Dispatch with its timeline, polled while it is in flight. Its list
 * row is looked up once, since the detail body carries no chain.
 */
export function useDispatch(
  id: string | null,
  known: DispatchSummary | undefined,
): Polled<LoadedDispatch> {
  const api = useApi();
  const summaries = useRef(new Map<string, DispatchSummary>());
  if (known) summaries.current.set(known.id, known);

  const load = useCallback(
    async (signal: AbortSignal): Promise<LoadedDispatch> => {
      const detail = await api.getDispatch(id!, signal);
      let summary = summaries.current.get(detail.id);
      if (!summary) {
        summary = await findSummary(api, detail, signal);
        summaries.current.set(detail.id, summary);
      }
      return { summary: { ...summary, status: detail.status }, detail };
    },
    [api, id],
  );

  return usePoll({
    key: `dispatch:${id}`,
    load,
    enabled: id !== null,
    delay: (loaded, previous) => nextDelay(inFlight(loaded.detail.status), previous),
  });
}
