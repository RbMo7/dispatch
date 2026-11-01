import { type Item, type ItemFilter, type ItemStatus, itemTarget } from '../../domain/dispatch';
import { ALL_STATUSES } from '../../domain/status';

/** Bundles of more items than this start collapsed. */
export const COLLAPSE_OVER = 20;

export type ItemRow =
  | { kind: 'item'; item: Item; bundled: boolean }
  | { kind: 'bundle'; hash: string; count: number; expanded: boolean }
  /** Why the item above it failed or was abandoned, on a line of its own. */
  | { kind: 'error'; item: Item };

/** Item counts per status, in the status table's order, for the filter chips. */
export function statusCounts(items: readonly Item[]): { status: ItemStatus; n: number }[] {
  const tally = new Map<ItemStatus, number>();
  for (const item of items) tally.set(item.status, (tally.get(item.status) ?? 0) + 1);
  return ALL_STATUSES.flatMap((status) => {
    const n = tally.get(status as ItemStatus);
    return n ? [{ status: status as ItemStatus, n }] : [];
  });
}

export function filterItems(items: readonly Item[], filter: ItemFilter, search: string): Item[] {
  const needle = search.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filter === 'all' || item.status === filter) &&
      (!needle ||
        itemTarget(item).toLowerCase().includes(needle) ||
        (item.transactionHash?.toLowerCase().includes(needle) ?? false)),
  );
}

/**
 * The table's rows: items in request order, except that items sharing one
 * transaction (a Solana bundle, a Bulk Call, a Proposal) sit under a heading
 * with their count. A bundle over 20 starts collapsed; `toggled` flips one.
 * An item with an error is followed by a row saying why.
 */
export function itemRows(items: readonly Item[], toggled: ReadonlySet<string>): ItemRow[] {
  const byHash = new Map<string, Item[]>();
  for (const item of items) {
    if (item.transactionHash === null) continue;
    const group = byHash.get(item.transactionHash);
    if (group) group.push(item);
    else byHash.set(item.transactionHash, [item]);
  }
  const rows: ItemRow[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const hash = item.transactionHash;
    const group = hash === null ? undefined : byHash.get(hash);
    if (hash === null || !group || group.length < 2) {
      rows.push({ kind: 'item', item, bundled: false });
      if (item.error) rows.push({ kind: 'error', item });
      continue;
    }
    if (placed.has(hash)) continue;
    placed.add(hash);
    const expanded = group.length <= COLLAPSE_OVER !== toggled.has(hash);
    rows.push({ kind: 'bundle', hash, count: group.length, expanded });
    if (expanded) {
      for (const member of group) {
        rows.push({ kind: 'item', item: member, bundled: true });
        if (member.error) rows.push({ kind: 'error', item: member });
      }
    }
  }
  return rows;
}
