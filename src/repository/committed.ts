import type { AssetAmount, Proposal } from '../domain/proposal.js';
import type { Payment } from '../domain/call.js';
import type { CommittedHolder } from './dispatch-store.js';

/** Sums amounts per asset (BigInt, so no precision is lost), in first-seen order. */
export function sumAssetAmounts(lists: readonly (readonly AssetAmount[])[]): AssetAmount[] {
  const totals = new Map<string, bigint>();
  for (const list of lists) {
    for (const { asset, amount } of list) {
      totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(amount));
    }
  }
  return [...totals].map(([asset, amount]) => ({ asset, amount: amount.toString() }));
}

/** Whether a Proposal's committed amounts still count: in flight, or timed out within the watch window (ADR-0053). */
export function holdsCommitment(
  proposal: Pick<Proposal, 'phase' | 'timedOutAt'>,
  timedOutSince: Date,
): boolean {
  switch (proposal.phase) {
    case 'noted':
    case 'open':
    case 'executing':
      return true;
    case 'timed_out':
      return (proposal.timedOutAt?.getTime() ?? 0) >= timedOutSince.getTime();
    case 'resolved':
      return false;
  }
}

/** What `listCommitted` totals for a holder: its Proposals' committed amounts, plus (for the Sender) the payments not yet in any Proposal. */
export function totalCommitted(
  holder: CommittedHolder,
  proposals: readonly Pick<Proposal, 'committed'>[],
  unproposedPayments: readonly (Payment | null)[],
): AssetAmount[] {
  const lists: AssetAmount[][] = proposals.map((p) => p.committed[holder]);
  if (holder === 'sender') {
    lists.push(
      unproposedPayments.flatMap((p) => (p ? [{ asset: p.asset, amount: p.amount }] : [])),
    );
  }
  return sumAssetAmounts(lists);
}
