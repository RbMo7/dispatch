/** A payment as read from a proposal, or from the file. */
export interface Item {
  recipient: string;
  asset: string;
  amount: bigint;
  /** Position in the file (file items only) or in the proposal (proposal items only). */
  position: number;
}

export type MismatchKind = 'amount' | 'asset' | 'extra';

/** A payment in the proposal that no file payment explains. */
export interface Mismatch {
  kind: MismatchKind;
  proposal: Item;
  /** The file payment it most resembles (same recipient and asset, or same recipient and amount). */
  file?: Item;
}

export interface Comparison {
  /** Proposal payments that matched a distinct file payment exactly. */
  matched: Item[];
  /** Proposal payments with no exact counterpart in the file. */
  mismatches: Mismatch[];
  /** File payments the proposal does not pay (not an error for a subset proposal). */
  uncovered: Item[];
}

const key = (i: Item) => `${i.recipient}\u0000${i.asset}\u0000${i.amount}`;

/**
 * Multiset comparison of what a proposal pays against the caller's file: each
 * proposal payment consumes one distinct, identical file payment. Anything left
 * over in the proposal is a mismatch; anything left over in the file is
 * "uncovered" (a proposal holds a subset of a Dispatch, ADR-0054).
 */
export function compare(proposal: Item[], file: Item[]): Comparison {
  const pool = new Map<string, Item[]>();
  for (const f of file) {
    const list = pool.get(key(f));
    if (list) list.push(f);
    else pool.set(key(f), [f]);
  }
  const matched: Item[] = [];
  const leftover: Item[] = [];
  for (const p of proposal) {
    const list = pool.get(key(p));
    if (list && list.length > 0) {
      list.shift();
      matched.push(p);
    } else leftover.push(p);
  }
  const unused = [...pool.values()].flat().sort((a, b) => a.position - b.position);

  const mismatches: Mismatch[] = [];
  for (const p of leftover) {
    let idx = unused.findIndex((f) => f.recipient === p.recipient && f.asset === p.asset);
    let kind: MismatchKind = 'amount';
    if (idx < 0) {
      idx = unused.findIndex((f) => f.recipient === p.recipient && f.amount === p.amount);
      kind = 'asset';
    }
    if (idx < 0) mismatches.push({ kind: 'extra', proposal: p });
    else {
      const [f] = unused.splice(idx, 1);
      mismatches.push({ kind, proposal: p, file: f as Item });
    }
  }
  return { matched, mismatches, uncovered: unused };
}

export interface AssetTotal {
  asset: string;
  count: number;
  total: bigint;
}

export function totalsByAsset(items: Item[]): AssetTotal[] {
  const map = new Map<string, AssetTotal>();
  for (const i of items) {
    const t = map.get(i.asset) ?? { asset: i.asset, count: 0, total: 0n };
    t.count++;
    t.total += i.amount;
    map.set(i.asset, t);
  }
  return [...map.values()].sort((a, b) => a.asset.localeCompare(b.asset));
}
