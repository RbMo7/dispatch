import type { DispatchItem } from '../domain/call.js';
import type { Dispatch, DispatchStatus, ItemStatus } from '../domain/dispatch.js';
import type { AssetAmount, Proposal } from '../domain/proposal.js';
import type { RelayDispatch } from '../domain/relay-dispatch.js';
import type { Transaction, TransactionStatus } from '../domain/transaction.js';
import { sumAssetAmounts } from '../repository/committed.js';
import type { DispatchStore, ListedDispatch } from '../repository/dispatch-store.js';
import { buildTimeline } from './timeline.js';

/** A Relay Dispatch's top-level status: its one Transaction's, read as an item (ADR-0031). */
function deriveRelayStatus(relayDispatch: RelayDispatch, transactions: Transaction[]): ItemStatus {
  const [transaction] = transactions;
  if (transaction) return toWireItemStatus(transaction.status);
  return relayDispatch.status === 'cancelled' ? 'cancelled' : 'queued';
}

/** The wire's lowercase per-item status vocabulary (docs/api.md) — distinct from Transaction's own uppercase one. */
function toWireItemStatus(status: TransactionStatus): ItemStatus {
  switch (status) {
    case 'PENDING':
      return 'broadcasting';
    case 'CONFIRMED':
      return 'confirmed';
    case 'FAILED':
      return 'failed';
    case 'ABANDONED':
      return 'abandoned';
    // ADR-0054: claimed but in no Proposal yet reads as `queued`; inside one, `awaiting_approval`.
    case 'UNPROPOSED':
      return 'queued';
    case 'AWAITING_APPROVAL':
      return 'awaiting_approval';
    case 'REPLACED':
    case 'DROPPED':
      throw new Error(`a ${status} Transaction is never a Call's reported version (ADR-0037)`);
  }
}

/** #9 (ADR-0037): a fee-bumped Call has several Transactions at one nonce — only the current one (latest while pending, or the one that settled it) is its reported version. */
function isCurrentVersion(transaction: Transaction): boolean {
  return transaction.status !== 'REPLACED' && transaction.status !== 'DROPPED';
}

/**
 * Dispatch.status only ever persists 'queued'/'broadcasting' (claimQueued's
 * own transition, ADR-0009's outbox) — the terminal wire statuses
 * (confirmed/failed/partial) are derived here from the aggregate of the
 * Dispatch's Transactions, never stored redundantly. ABANDONED counts
 * alongside FAILED for this aggregate: the Coordinator has stopped
 * actively watching it, even though it might still confirm later — that
 * nuance stays visible at the per-item level (docs/api.md), not lost, just
 * not double-counted as "in progress" here.
 */
function deriveDispatchStatus(dispatch: Dispatch, transactions: Transaction[]): DispatchStatus {
  if (dispatch.status === 'queued' || dispatch.status === 'cancelled') return dispatch.status;

  // ADR-0054: a Call waiting to be proposed or approved is still in progress, and the Dispatch gains no status of its own for it.
  const stillPending =
    transactions.length < dispatch.items.length ||
    transactions.some(
      (t) =>
        t.status === 'PENDING' || t.status === 'UNPROPOSED' || t.status === 'AWAITING_APPROVAL',
    );
  if (stillPending) return 'broadcasting';

  const confirmedCount = transactions.filter((t) => t.status === 'CONFIRMED').length;
  if (confirmedCount === transactions.length) return 'confirmed';
  if (confirmedCount === 0) return 'failed';
  return 'partial';
}

/** What the caller asked for on an item, as docs/api.md names it, so a reader never has to decode the Call. */
function toWireRequest({ call, payment }: DispatchItem) {
  if (payment) {
    const { recipient, asset, amount } = payment;
    return { type: 'payment' as const, recipient, asset, amount };
  }
  return 'to' in call
    ? { type: 'call' as const, to: call.to }
    : { type: 'call' as const, programId: call.programId };
}

/** docs/api.md's per-item `approval` block: what the Approvers have done about the Proposal this Call is in. */
function toWireApproval(proposal: Proposal) {
  return {
    state: proposal.approvalState,
    approvals: proposal.approvals,
    threshold: proposal.threshold,
    deadline: proposal.deadlineAt.toISOString(),
    expected: proposal.expected,
    chainRef: proposal.chainRef,
  };
}

/** `GET /v1/dispatch/:id`'s body for a Managed or Relay Dispatch, or null when neither exists. */
export async function readDispatchView(
  store: DispatchStore,
  id: string,
  options: { timeline: boolean } = { timeline: false },
) {
  const dispatch = await store.getDispatch(id);
  if (dispatch) {
    const allVersions = await store.listTransactions(dispatch.id);
    const transactions = allVersions.filter(isCurrentVersion);
    const transactionByCallIndex = new Map(transactions.map((t) => [t.callIndex, t]));
    // ADR-0054: only a multisig Dispatch has Proposals; everyone else costs no extra read. The API never calls a chain.
    const proposals = transactions.some((t) => t.proposalId !== null)
      ? await store.listProposalsForDispatch(dispatch.id)
      : [];
    const proposalById = new Map(proposals.map((p) => [p.id, p]));

    const items = dispatch.items.map((item, index) => {
      const request = toWireRequest(item);
      if (dispatch.status === 'cancelled') {
        return { ...request, status: 'cancelled', transactionHash: null, error: null };
      }
      const transaction = transactionByCallIndex.get(index);
      if (!transaction) {
        return { ...request, status: 'queued', transactionHash: null, error: null };
      }
      const proposal = transaction.proposalId
        ? proposalById.get(transaction.proposalId)
        : undefined;
      return {
        ...request,
        status: toWireItemStatus(transaction.status),
        transactionHash: transaction.hash,
        error: transaction.error,
        ...(proposal ? { approval: toWireApproval(proposal) } : {}),
      };
    });

    return {
      dispatchId: dispatch.id,
      mode: 'managed',
      status: deriveDispatchStatus(dispatch, transactions),
      items,
      ...(options.timeline
        ? {
            timeline: buildTimeline({
              dispatch,
              transactions: allVersions,
              attempts: await store.listAttempts(dispatch.id),
              proposals,
            }),
          }
        : {}),
    };
  }

  // ADR-0031: a Relay Dispatch is always exactly one already-signed
  // transaction, never a batch — its response shape (dispatchId, mode,
  // status, transactionHash, error) is honestly distinct from Managed
  // Dispatch's items-array shape, not a fake single-item version of it.
  const relayDispatch = await store.getRelayDispatch(id);
  if (relayDispatch) {
    const relayTransactions = await store.listTransactions(relayDispatch.id);
    const [transaction] = relayTransactions;
    return {
      dispatchId: relayDispatch.id,
      mode: 'relay',
      status: deriveRelayStatus(relayDispatch, relayTransactions),
      transactionHash: transaction?.hash ?? null,
      error: transaction?.error ?? null,
      ...(options.timeline
        ? {
            timeline: buildTimeline({
              dispatch: relayDispatch,
              transactions: relayTransactions,
              attempts: await store.listAttempts(relayDispatch.id),
              proposals: [],
            }),
          }
        : {}),
    };
  }

  return null;
}

/** #110: one row of `GET /v1/dispatches`: the `GET /v1/dispatch/:id` summary without items, plus what a list needs. */
export function summarizeDispatch(listed: ListedDispatch) {
  if (listed.mode === 'relay') {
    const [transaction] = listed.transactions;
    return {
      dispatchId: listed.dispatch.id,
      mode: 'relay' as const,
      chain: listed.dispatch.chain,
      status: deriveRelayStatus(listed.dispatch, listed.transactions),
      transactionHash: transaction?.hash ?? null,
      error: transaction?.error ?? null,
      createdAt: listed.dispatch.createdAt,
      itemCount: 1,
      totals: [] as AssetAmount[],
    };
  }
  const { dispatch } = listed;
  return {
    dispatchId: dispatch.id,
    mode: 'managed' as const,
    chain: dispatch.chain,
    status: deriveDispatchStatus(dispatch, listed.transactions.filter(isCurrentVersion)),
    createdAt: dispatch.createdAt,
    itemCount: dispatch.items.length,
    totals: sumAssetAmounts([
      dispatch.items.flatMap(({ payment }) =>
        payment ? [{ asset: payment.asset, amount: payment.amount }] : [],
      ),
    ]),
  };
}
