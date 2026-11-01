import { dispatchName, type DispatchSummary } from '../../domain/dispatch';
import { type ApiClient, type ListFilters, PAGE_LIMIT } from '../api/client';

/** The page's search over loaded rows: an id or id prefix, or the row's name. */
export function matchesSearch(row: DispatchSummary, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return (
    row.id.toLowerCase().startsWith(needle) || dispatchName(row).toLowerCase().includes(needle)
  );
}

/**
 * Every Dispatch matching the filters, walking the cursor until the last page.
 * A `status` filter may return short or empty pages before the end, so only a
 * null cursor stops it.
 */
export async function collectDispatches(
  api: ApiClient,
  filters: ListFilters,
  search: string,
  onProgress: (read: number) => void,
  signal: AbortSignal,
): Promise<DispatchSummary[]> {
  const rows: DispatchSummary[] = [];
  let cursor: string | null = null;
  do {
    const page = await api.listDispatches(filters, { cursor, limit: PAGE_LIMIT }, signal);
    rows.push(...page.dispatches.filter((row) => matchesSearch(row, search)));
    onProgress(rows.length);
    cursor = page.nextCursor;
  } while (cursor && !signal.aborted);
  return rows;
}
