import type { DispatchError } from '../domain/errors.js';
import type { ApprovalState, ChainProposalRef, Proposal } from '../domain/proposal.js';
import type { Attempt, Transaction } from '../domain/transaction.js';
import { feeOf, type FeeView } from './signed-view.js';

/**
 * #109: one moment in a Dispatch's history, rebuilt from timestamps the
 * engine already stores (no event table, ADR-0014). `items` are the
 * positions of the Calls an entry is about; `hash` names the Transaction
 * version (every Call of a bundle shares one).
 */
export type TimelineEntry =
  | { kind: 'created'; at: Date }
  | { kind: 'claimed'; at: Date }
  | { kind: 'cancelled'; at: Date }
  | {
      kind: 'written';
      at: Date;
      hash: string;
      items: number[];
      replaces: string | null;
      /** Base: the fees this version was signed with, so a fee bump shows before and after. */
      fee?: FeeView;
    }
  | { kind: 'sent'; at: Date; hash: string; items: number[] }
  | { kind: 'attempt'; at: Date; hash: string; items: number[]; error: DispatchError | null }
  | { kind: 'replaced'; at: Date; hash: string; items: number[]; by: string | null }
  | {
      kind: 'dropped';
      at: Date;
      hash: string;
      items: number[];
      by: string | null;
      /** ADR-0064: why, when nothing else settled the Call (another sender took its nonce). */
      error?: DispatchError;
    }
  | { kind: 'confirmed'; at: Date; hash: string | null; items: number[] }
  | { kind: 'failed'; at: Date; hash: string | null; items: number[]; error: DispatchError | null }
  | {
      kind: 'abandoned';
      at: Date;
      hash: string | null;
      items: number[];
      error: DispatchError | null;
    }
  | {
      kind: 'proposal_created';
      at: Date;
      proposalId: string;
      chainRef: ChainProposalRef;
      items: number[];
    }
  | {
      kind: 'proposal_approval';
      /** When the Approvers' decision was acted on; null while the Proposal is still open, as the counts are only as last read. */
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

export type TimelineSource = {
  dispatch: { createdAt: Date; firstClaimedAt: Date | null; cancelledAt: Date | null };
  /** Every version, REPLACED and DROPPED included. */
  transactions: Transaction[];
  attempts: Attempt[];
  proposals: Proposal[];
};

type Outcome = Extract<
  TimelineEntry,
  { kind: 'replaced' | 'dropped' | 'confirmed' | 'failed' | 'abandoned' }
>;

export function buildTimeline({
  dispatch,
  transactions,
  attempts,
  proposals,
}: TimelineSource): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ kind: 'created', at: dispatch.createdAt }];
  if (dispatch.firstClaimedAt) entries.push({ kind: 'claimed', at: dispatch.firstClaimedAt });
  if (dispatch.cancelledAt) entries.push({ kind: 'cancelled', at: dispatch.cancelledAt });

  const byId = new Map(transactions.map((t) => [t.id, t]));
  const successorOf = new Map(
    transactions.flatMap((t) => (t.replacesTransactionId ? [[t.replacesTransactionId, t]] : [])),
  );
  const settledAt = (callIndex: number): Date | null => {
    const settled = transactions.find(
      (t) => t.callIndex === callIndex && (t.status === 'CONFIRMED' || t.status === 'FAILED'),
    );
    return settled?.confirmedAt ?? settled?.failedAt ?? null;
  };

  const versions = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const key = t.hash ?? `row:${t.id}`;
    versions.set(key, [...(versions.get(key) ?? []), t]);
  }

  for (const rows of versions.values()) {
    const [first] = rows;
    if (!first) continue;
    const hash = first.hash;
    const items = callIndexes(rows);
    const rowAttempts = attempts.filter((a) => a.transactionId === first.id);

    if (hash !== null && first.broadcastAt) {
      const predecessor = first.replacesTransactionId
        ? byId.get(first.replacesTransactionId)
        : undefined;
      const fee = feeOf(first.chain, first.signedBytes);
      entries.push({
        kind: 'written',
        at: first.broadcastAt,
        hash,
        items,
        replaces: predecessor?.hash ?? null,
        ...(fee ? { fee } : {}),
      });
      if (first.sentAt) entries.push({ kind: 'sent', at: first.sentAt, hash, items });
      for (const attempt of rowAttempts) {
        entries.push({
          kind: 'attempt',
          at: attempt.broadcastAt,
          hash,
          items,
          error: attempt.error,
        });
      }
    }

    const outcomes = new Map<string, Outcome>();
    const add = (outcome: Outcome) => {
      const key = `${outcome.kind}\u0000${'error' in outcome ? (outcome.error?.code ?? '') : ''}`;
      const existing = outcomes.get(key);
      if (!existing) outcomes.set(key, outcome);
      else {
        existing.items = [...new Set([...existing.items, ...outcome.items])].sort((a, b) => a - b);
        if (outcome.at < existing.at) existing.at = outcome.at;
      }
    };
    for (const row of rows) {
      const item = [row.callIndex];
      const successor = successorOf.get(row.id);
      // A replaced version can still be the one that lands (ADR-0037); a dropped one says so itself.
      if (successor?.broadcastAt && hash !== null && row.status !== 'DROPPED') {
        add({ kind: 'replaced', at: successor.broadcastAt, hash, items: item, by: successor.hash });
      }
      if (row.abandonedAt) {
        add({ kind: 'abandoned', at: row.abandonedAt, hash, items: item, error: row.error });
      }
      switch (row.status) {
        case 'CONFIRMED':
          if (row.confirmedAt) add({ kind: 'confirmed', at: row.confirmedAt, hash, items: item });
          break;
        case 'FAILED':
          if (row.failedAt) {
            add({ kind: 'failed', at: row.failedAt, hash, items: item, error: row.error });
          }
          break;
        case 'DROPPED': {
          const droppedAt =
            successor?.broadcastAt ??
            settledAt(row.callIndex) ??
            row.lastBroadcastAt ??
            row.broadcastAt;
          if (hash !== null && droppedAt) {
            add({
              kind: 'dropped',
              at: droppedAt,
              hash,
              items: item,
              by: successor?.hash ?? null,
              ...(row.error ? { error: row.error } : {}),
            });
          }
          break;
        }
        default:
          break;
      }
    }
    entries.push(...outcomes.values());
  }

  for (const proposal of proposals) entries.push(...proposalEntries(proposal, transactions));

  return entries.sort(compareEntries);
}

function proposalEntries(proposal: Proposal, transactions: Transaction[]): TimelineEntry[] {
  const calls = transactions.filter((t) => t.proposalId === proposal.id);
  const entries: TimelineEntry[] = [
    {
      kind: 'proposal_created',
      at: proposal.createdAt,
      proposalId: proposal.id,
      chainRef: proposal.chainRef,
      items: callIndexes(calls),
    },
  ];
  const executeWrittenAt = calls
    .flatMap((t) => (t.hash !== null && t.broadcastAt ? [t.broadcastAt] : []))
    .sort((a, b) => a.getTime() - b.getTime())[0];
  entries.push({
    kind: 'proposal_approval',
    at: executeWrittenAt ?? proposal.timedOutAt ?? proposal.resolvedAt,
    proposalId: proposal.id,
    state: proposal.approvalState,
    approvals: proposal.approvals,
    threshold: proposal.threshold,
  });
  if (proposal.timedOutAt) {
    entries.push({ kind: 'proposal_timed_out', at: proposal.timedOutAt, proposalId: proposal.id });
  }
  if (proposal.resolvedAt) {
    entries.push({
      kind: 'proposal_resolved',
      at: proposal.resolvedAt,
      proposalId: proposal.id,
      outcome: calls.some((t) => t.status === 'CONFIRMED')
        ? 'executed'
        : calls.some((t) => t.error?.code === 'APPROVAL_REJECTED')
          ? 'rejected'
          : 'failed',
    });
  }
  return entries;
}

function callIndexes(rows: Transaction[]): number[] {
  return [...new Set(rows.map((t) => t.callIndex))].sort((a, b) => a - b);
}

/** Breaks ties between entries stamped in the same millisecond in the order they happen. */
const KIND_ORDER: Record<TimelineEntry['kind'], number> = {
  created: 0,
  claimed: 1,
  cancelled: 2,
  proposal_created: 3,
  proposal_approval: 4,
  written: 5,
  sent: 6,
  attempt: 7,
  confirmed: 8,
  failed: 8,
  abandoned: 8,
  replaced: 9,
  dropped: 9,
  proposal_timed_out: 10,
  proposal_resolved: 10,
};

function compareEntries(a: TimelineEntry, b: TimelineEntry): number {
  const at = (entry: TimelineEntry) => entry.at?.getTime() ?? Number.POSITIVE_INFINITY;
  return at(a) - at(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
}
