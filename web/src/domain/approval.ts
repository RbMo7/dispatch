import type { Approval, ApproverDecision, ChainRef, Item } from './dispatch';
import type { Status } from './status';

/** Each decision is a text pill on the tint of the status it reads like. */
export const DECISIONS: Record<ApproverDecision, { label: string; tone: Status }> = {
  approved: { label: 'Approved', tone: 'confirmed' },
  rejected: { label: 'Rejected', tone: 'failed' },
  pending: { label: 'Pending', tone: 'queued' },
};

const count = new Intl.NumberFormat('en-US');

/** "1 of 2 approved, 1 more needed", or "2 of 2 approved" once nothing more is needed. */
export function approvalProgress({
  approvals,
  threshold,
  remaining,
}: Pick<Approval, 'approvals' | 'threshold' | 'remaining'>): string {
  const reached = `${count.format(approvals)} of ${count.format(threshold)} approved`;
  return remaining > 0 ? `${reached}, ${count.format(remaining)} more needed` : reached;
}

export interface ProposalApproval {
  approval: Approval;
  /** The indexes of the items it holds. */
  items: number[];
}

function proposalKey(ref: ChainRef): string {
  return ref.kind === 'squads' ? ref.proposal : ref.safeTxHash;
}

/** One entry per Proposal, in the order of its first item. */
export function proposalApprovals(items: readonly Item[]): ProposalApproval[] {
  const byKey = new Map<string, ProposalApproval>();
  for (const item of items) {
    if (!item.approval) continue;
    const key = proposalKey(item.approval.chainRef);
    const known = byKey.get(key);
    if (known) known.items.push(item.index);
    else byKey.set(key, { approval: item.approval, items: [item.index] });
  }
  return [...byKey.values()];
}
