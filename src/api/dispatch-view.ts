import type { DispatchItem } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { Dispatch, DispatchStatus, ItemStatus } from '../domain/dispatch.js';
import type { Hold } from '../domain/flag-rule.js';
import type { AssetAmount, Proposal } from '../domain/proposal.js';
import type { RelayDispatch } from '../domain/relay-dispatch.js';
import type { Transaction, TransactionStatus } from '../domain/transaction.js';
import { sumAssetAmounts } from '../repository/committed.js';
import type { DispatchStore, ListedDispatch } from '../repository/dispatch-store.js';
import type { AssetDecimals } from '../asset-registry/asset-registry.js';
import { toWireDefinition } from './flag-rule-wire.js';
import { buildTimeline } from './timeline.js';

/** ADR-0060: the configured name of the Sender at an address, or null when no Sender has it any more. */
export type SenderNameOf = (chain: Chain, address: string) => string | null;

/** The senders file's label for an Approver of a Multisig Sender, or null when it gives none. */
export type ApproverLabelOf = (
  chain: Chain,
  senderAddress: string,
  approver: string,
) => string | null;

/**
 * ADR-0060: who pays, by address (its identity) and by name. Absent only for
 * a Dispatch stored with no Sender, which its chain's default takes over.
 */
function senderView(dispatch: Dispatch, nameOf: SenderNameOf | undefined) {
  if (dispatch.senderAddress === null) return {};
  return {
    sender: {
      name: nameOf?.(dispatch.chain, dispatch.senderAddress) ?? null,
      address: dispatch.senderAddress,
    },
  };
}

function deriveRelayStatus(relayDispatch: RelayDispatch, transactions: Transaction[]): ItemStatus {
  const [transaction] = transactions;
  if (transaction) return toWireItemStatus(transaction.status);
  return relayDispatch.status === 'cancelled' ? 'cancelled' : 'queued';
}

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
 * nuance stays visible at the per-item level (docs/openapi.yaml), not lost, just
 * not double-counted as "in progress" here.
 */
function deriveDispatchStatus(dispatch: Dispatch, transactions: Transaction[]): DispatchStatus {
  if (
    dispatch.status === 'queued' ||
    dispatch.status === 'held' ||
    dispatch.status === 'cancelled'
  ) {
    return dispatch.status;
  }

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

function toWireRequest(chain: Chain, { call, payment }: DispatchItem, decimalsOf: AssetDecimals) {
  if (payment) {
    const { recipient, asset, amount } = payment;
    const decimals = decimalsOf(chain, asset);
    return {
      type: 'payment' as const,
      recipient,
      asset,
      ...(decimals === undefined ? {} : { decimals }),
      amount,
    };
  }
  return 'to' in call
    ? { type: 'call' as const, to: call.to }
    : { type: 'call' as const, programId: call.programId };
}

function toWireApproval(proposal: Proposal, labelOf: ApproverLabelOf | undefined) {
  return {
    state: proposal.approvalState,
    approvals: proposal.approvals,
    threshold: proposal.threshold,
    remaining: Math.max(0, proposal.threshold - proposal.approvals),
    approvers: proposal.approvers.map(({ address, decision }) => {
      const label = labelOf?.(proposal.chain, proposal.senderAddress, address) ?? null;
      return { address, ...(label === null ? {} : { label }), decision };
    }),
    deadline: proposal.deadlineAt.toISOString(),
    expected: proposal.expected,
    chainRef: proposal.chainRef,
  };
}

/** ADR-0056: who cancelled a cancelled Dispatch, when and why, from the operator action the cancel recorded. */
async function cancellationView(store: DispatchStore, id: string, status: string) {
  if (status !== 'cancelled') return {};
  const cancel = await store.getCancellation(id);
  if (!cancel) return {};
  return {
    cancellation: {
      at: cancel.at.toISOString(),
      tokenKind: cancel.tokenKind,
      reason: cancel.reason,
    },
  };
}

/** ADR-0058: which rule versions matched which items, and the release. Kept after a release or cancel. */
function toWireHold(hold: Hold) {
  return {
    matched: hold.matched.map(({ rule, items }) => ({
      rule: { name: rule.name, ...toWireDefinition(rule.definition) },
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      items,
    })),
    heldAt: hold.heldAt.toISOString(),
    ...(hold.release
      ? { releasedAt: hold.release.at.toISOString(), reason: hold.release.reason }
      : {}),
  };
}

export async function readDispatchView(
  store: DispatchStore,
  id: string,
  decimalsOf: AssetDecimals,
  options: { timeline?: boolean; nameOf?: SenderNameOf; approverLabelOf?: ApproverLabelOf } = {},
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
    const hold = await store.getHold(dispatch.id);

    const items = dispatch.items.map((item, index) => {
      const request = toWireRequest(dispatch.chain, item, decimalsOf);
      if (dispatch.status === 'cancelled' || dispatch.status === 'held') {
        return { ...request, status: dispatch.status, transactionHash: null, error: null };
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
        ...(proposal ? { approval: toWireApproval(proposal, options.approverLabelOf) } : {}),
      };
    });

    return {
      dispatchId: dispatch.id,
      mode: 'managed',
      chain: dispatch.chain,
      ...senderView(dispatch, options.nameOf),
      createdAt: dispatch.createdAt,
      status: deriveDispatchStatus(dispatch, transactions),
      items,
      ...(hold ? { hold: toWireHold(hold) } : {}),
      ...(await cancellationView(store, dispatch.id, dispatch.status)),
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
      chain: relayDispatch.chain,
      createdAt: relayDispatch.createdAt,
      status: deriveRelayStatus(relayDispatch, relayTransactions),
      transactionHash: transaction?.hash ?? null,
      error: transaction?.error ?? null,
      ...(await cancellationView(store, relayDispatch.id, relayDispatch.status)),
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

export function summarizeDispatch(
  listed: ListedDispatch,
  decimalsOf: AssetDecimals,
  nameOf?: SenderNameOf,
) {
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
      totals: [] as (AssetAmount & { decimals?: number })[],
    };
  }
  const { dispatch } = listed;
  return {
    dispatchId: dispatch.id,
    mode: 'managed' as const,
    chain: dispatch.chain,
    ...senderView(dispatch, nameOf),
    status: deriveDispatchStatus(dispatch, listed.transactions.filter(isCurrentVersion)),
    createdAt: dispatch.createdAt,
    itemCount: dispatch.items.length,
    totals: sumAssetAmounts([
      dispatch.items.flatMap(({ payment }) =>
        payment ? [{ asset: payment.asset, amount: payment.amount }] : [],
      ),
    ]).map((total) => {
      const decimals = decimalsOf(dispatch.chain, total.asset);
      return decimals === undefined ? total : { ...total, decimals };
    }),
  };
}
