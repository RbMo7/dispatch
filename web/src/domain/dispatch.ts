import type { Money } from './assets';
import type { Chain } from './chains';
import type { Status } from './status';

export type Mode = 'managed' | 'relay';

/** A row of `GET /v1/dispatches`: what the list, the Overview and the export read. */
export interface DispatchSummary {
  id: string;
  mode: Mode;
  chain: Chain;
  status: Status;
  createdAt: Date;
  itemCount: number;
  /** Per asset, summed over `payment` items. Empty for a Relay Dispatch. */
  totals: Money[];
}

/** docs/api.md's per-item status, also a Relay Dispatch's top-level one. */
export type ItemStatus = Extract<
  Status,
  | 'queued'
  | 'awaiting_approval'
  | 'broadcasting'
  | 'confirmed'
  | 'failed'
  | 'abandoned'
  | 'cancelled'
>;

export const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>([
  'queued',
  'broadcasting',
  'awaiting_approval',
  'held',
]);

export function inFlight(status: Status): boolean {
  return IN_FLIGHT.has(status);
}

export interface DispatchError {
  code: string;
  message: string;
  /** `INSUFFICIENT_FUNDS`'s shortfall, in the asset's smallest unit. */
  short?: { asset: string; raw: string };
}

export type ChainRef =
  | { kind: 'squads'; multisig: string; proposal: string; transactionIndex: number }
  | { kind: 'safe'; safe: string; safeTxHash: string; nonce: number };

export type ApprovalState = 'awaiting' | 'approved' | 'approved_after_deadline';

export interface Approval {
  state: ApprovalState;
  approvals: number;
  threshold: number;
  deadline: Date;
  chainRef: ChainRef;
}

interface ItemBase {
  index: number;
  status: ItemStatus;
  transactionHash: string | null;
  error: DispatchError | null;
  /** Present whenever the item's Call belongs to a multisig Proposal. */
  approval: Approval | null;
}

export interface PaymentItem extends ItemBase {
  type: 'payment';
  recipient: string;
  asset: string;
  /** Null when the asset is no longer configured, so the engine reports no decimals for it. */
  amount: Money | null;
}

export interface CallItem extends ItemBase {
  type: 'call';
  /** `to` on Base, `programId` on Solana. */
  target: string;
}

export type Item = PaymentItem | CallItem;

export function itemTarget(item: Item): string {
  return item.type === 'payment' ? item.recipient : item.target;
}

export function itemAmount(item: Item): Money | null {
  return item.type === 'payment' ? item.amount : null;
}

export function itemAsset(item: Item): string | null {
  return item.type === 'payment' ? item.asset : null;
}

export type ItemFilter = 'all' | ItemStatus;

/** `GET /v1/dispatch/:id?include=timeline`'s entries, oldest first (docs/api.md). */
export type TimelineEntry =
  | { kind: 'created' | 'claimed' | 'cancelled'; at: Date }
  | { kind: 'written'; at: Date; hash: string; items: number[]; replaces: string | null }
  | { kind: 'sent'; at: Date; hash: string; items: number[] }
  | { kind: 'attempt'; at: Date; hash: string; items: number[]; error: DispatchError | null }
  | { kind: 'replaced' | 'dropped'; at: Date; hash: string; items: number[]; by: string | null }
  | { kind: 'confirmed'; at: Date; hash: string | null; items: number[] }
  | {
      kind: 'failed' | 'abandoned';
      at: Date;
      hash: string | null;
      items: number[];
      error: DispatchError | null;
    }
  | { kind: 'proposal_created'; at: Date; proposalId: string; chainRef: ChainRef; items: number[] }
  | {
      kind: 'proposal_approval';
      /** Null while the Proposal is still open: the counts are only as last read. */
      at: Date | null;
      proposalId: string;
      state: ApprovalState;
      approvals: number;
      threshold: number;
    }
  | { kind: 'proposal_timed_out'; at: Date; proposalId: string }
  | {
      kind: 'proposal_resolved';
      at: Date;
      proposalId: string;
      outcome: 'executed' | 'rejected' | 'failed';
    };

/** One kind of timeline entry; an intersection, so kinds sharing a variant narrow too. */
export type EntryOf<K extends TimelineEntry['kind']> = TimelineEntry & { kind: K };

export interface ManagedDetail {
  mode: 'managed';
  id: string;
  chain: Chain;
  createdAt: Date;
  status: Status;
  items: Item[];
  timeline: TimelineEntry[];
}

export interface RelayDetail {
  mode: 'relay';
  id: string;
  chain: Chain;
  createdAt: Date;
  status: ItemStatus;
  transactionHash: string | null;
  error: DispatchError | null;
  timeline: TimelineEntry[];
}

export type DispatchDetail = ManagedDetail | RelayDetail;

/** A Dispatch as the pane shows it: its list row, as the detail alone gives it, plus its items and timeline. */
export interface LoadedDispatch {
  summary: DispatchSummary;
  detail: DispatchDetail;
}

/** The list row for a Dispatch, from its detail: `totals` sums the `payment` items the engine reports decimals for. */
export function summaryOf(detail: DispatchDetail): DispatchSummary {
  const { id, mode, chain, status, createdAt } = detail;
  if (detail.mode === 'relay')
    return { id, mode, chain, status, createdAt, itemCount: 1, totals: [] };
  const totals = new Map<string, Money>();
  for (const item of detail.items) {
    const amount = itemAmount(item);
    if (!amount) continue;
    const sum = totals.get(amount.asset);
    totals.set(
      amount.asset,
      sum ? { ...sum, raw: (BigInt(sum.raw) + BigInt(amount.raw)).toString() } : amount,
    );
  }
  return {
    id,
    mode,
    chain,
    status,
    createdAt,
    itemCount: detail.items.length,
    totals: [...totals.values()],
  };
}

const count = new Intl.NumberFormat('en-US');

/** The engine stores no label, so a Dispatch is named by what it carries: "37 payments". */
export function dispatchName(summary: Pick<DispatchSummary, 'mode' | 'itemCount' | 'totals'>) {
  if (summary.mode === 'relay') return 'Relay transaction';
  const n = summary.itemCount;
  const noun = summary.totals.length > 0 ? 'payment' : 'item';
  return `${count.format(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** Ids are UUIDs; the list and pane show the first block, as the board does. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
