import { randomUUID } from 'node:crypto';

import type { Chain } from '../domain/chain.js';
import type { Dispatch } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { AssetAmount, Proposal } from '../domain/proposal.js';
import type { RelayDispatch } from '../domain/relay-dispatch.js';
import type { Attempt, Transaction } from '../domain/transaction.js';
import { holdsCommitment, totalCommitted } from './committed.js';
import type {
  ChainScope,
  CommittedHolder,
  DispatchStore,
  NewDispatchInput,
  NewFailedCallInput,
  NewProposalInput,
  NewRelayDispatchInput,
  NewTransactionInput,
  NewUnproposedInput,
  ProposalOutcome,
  ProposalPatch,
} from './dispatch-store.js';

/**
 * The fake ADR-0011 calls for: same interface as PostgresDispatchStore, no
 * I/O, so Coordinator unit tests never need a real database. Methods return
 * Promise.resolve()/settle() rather than being declared async, since there's
 * no await in a synchronous, in-memory implementation — settle() still turns
 * a thrown error into a rejection, so callers see the same Promise-rejecting
 * behavior an async method would give them for free.
 */
export class InMemoryDispatchStore implements DispatchStore {
  private readonly dispatches = new Map<string, Dispatch>();
  private readonly transactions = new Map<string, Transaction>();
  private readonly attempts = new Map<string, Attempt[]>();
  private readonly relayDispatches = new Map<string, RelayDispatch>();
  private readonly proposals = new Map<string, Proposal>();
  /** #20: when each Dispatch / Relay Dispatch was last claimed. */
  private readonly claimedAt = new Map<string, Date>();

  /** Injectable so orchestration tests (e.g. the ABANDONED timeout) can control elapsed time deterministically. */
  constructor(private readonly now: () => Date = () => new Date()) {}

  createDispatch<C extends Chain>(input: NewDispatchInput<C>): Promise<Dispatch<C>> {
    const existing = [...this.dispatches.values()].find(
      (dispatch) => dispatch.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      return Promise.resolve(existing as Dispatch<C>);
    }

    const dispatch: Dispatch<C> = {
      id: randomUUID(),
      chain: input.chain,
      idempotencyKey: input.idempotencyKey,
      items: input.items,
      status: 'queued',
      retryPolicy: input.retryPolicy,
      bulkCall: input.bulkCall ?? null,
    };
    this.dispatches.set(dispatch.id, dispatch);

    return Promise.resolve(dispatch);
  }

  getDispatch(id: string): Promise<Dispatch | null> {
    return Promise.resolve(this.dispatches.get(id) ?? null);
  }

  listTransactions(dispatchId: string): Promise<Transaction[]> {
    const matches = [...this.transactions.values()]
      .filter((transaction) => transaction.dispatchId === dispatchId)
      .sort((a, b) => a.callIndex - b.callIndex);

    return Promise.resolve(matches);
  }

  claimQueued(chains: ChainScope, limit: number): Promise<Dispatch[]> {
    const claimed: Dispatch[] = [];
    for (const dispatch of this.dispatches.values()) {
      if (claimed.length >= limit) break;
      if (dispatch.status !== 'queued' || !chains.includes(dispatch.chain)) continue;

      const broadcasting: Dispatch = { ...dispatch, status: 'broadcasting' };
      this.dispatches.set(dispatch.id, broadcasting);
      this.claimedAt.set(dispatch.id, this.now());
      claimed.push(broadcasting);
    }

    return Promise.resolve(claimed);
  }

  createTransaction(input: NewTransactionInput): Promise<Transaction> {
    const transaction: Transaction = {
      id: randomUUID(),
      dispatchId: input.dispatchId,
      callIndex: input.callIndex,
      chain: input.chain,
      hash: input.hash,
      signedBytes: input.signedBytes,
      status: 'PENDING',
      error: null,
      broadcastAt: this.now(),
      abandonedAt: null,
      confirmedAt: null,
      lastCheckedAt: null,
      lastBroadcastAt: this.now(),
      replacesTransactionId: null,
      feeBumpAttempts: 0,
      proposalId: null,
      proposalPosition: null,
    };
    this.transactions.set(transaction.id, transaction);
    this.attempts.set(transaction.id, []);

    return Promise.resolve(transaction);
  }

  async createTransactions(inputs: NewTransactionInput[]): Promise<Transaction[]> {
    const created: Transaction[] = [];
    for (const input of inputs) created.push(await this.createTransaction(input));
    return created;
  }

  listUnsettledTransactions(chain: Chain): Promise<Transaction[]> {
    return Promise.resolve(
      [...this.transactions.values()].filter(
        (t) => t.chain === chain && (t.status === 'PENDING' || t.status === 'REPLACED'),
      ),
    );
  }

  touchClaims(dispatchIds: string[]): Promise<void> {
    for (const id of dispatchIds) if (this.claimedAt.has(id)) this.claimedAt.set(id, this.now());
    return Promise.resolve();
  }

  recordCallFailure(input: NewFailedCallInput): Promise<Transaction> {
    const transaction: Transaction = {
      id: randomUUID(),
      dispatchId: input.dispatchId,
      callIndex: input.callIndex,
      chain: input.chain,
      hash: null,
      signedBytes: null,
      status: 'FAILED',
      error: input.error,
      broadcastAt: null,
      abandonedAt: null,
      confirmedAt: null,
      lastCheckedAt: null,
      lastBroadcastAt: null,
      replacesTransactionId: null,
      feeBumpAttempts: 0,
      proposalId: null,
      proposalPosition: null,
    };
    this.transactions.set(transaction.id, transaction);
    this.attempts.set(transaction.id, []);

    return Promise.resolve(transaction);
  }

  listPendingTransactions(chains: ChainScope, limit: number): Promise<Transaction[]> {
    const pending = [...this.transactions.values()]
      .filter(
        (transaction) => transaction.status === 'PENDING' && chains.includes(transaction.chain),
      )
      .sort(
        (a, b) =>
          (a.lastCheckedAt?.getTime() ?? -Infinity) - (b.lastCheckedAt?.getTime() ?? -Infinity) ||
          (a.broadcastAt?.getTime() ?? 0) - (b.broadcastAt?.getTime() ?? 0),
      )
      .slice(0, limit);

    const lastCheckedAt = this.now();
    const stamped = pending.map((transaction) => ({ ...transaction, lastCheckedAt }));
    for (const transaction of stamped) this.transactions.set(transaction.id, transaction);
    return Promise.resolve(stamped);
  }

  listAbandonedTransactions(
    chains: ChainScope,
    limit: number,
    notAbandonedBefore: Date,
  ): Promise<Transaction[]> {
    const abandoned = [...this.transactions.values()]
      .filter(
        (transaction) =>
          transaction.status === 'ABANDONED' &&
          transaction.hash !== null &&
          chains.includes(transaction.chain) &&
          (transaction.abandonedAt?.getTime() ?? 0) >= notAbandonedBefore.getTime(),
      )
      .sort((a, b) => (a.abandonedAt?.getTime() ?? 0) - (b.abandonedAt?.getTime() ?? 0))
      .slice(0, limit);

    return Promise.resolve(abandoned);
  }

  listRecentlyConfirmedTransactions(
    chain: Chain,
    limit: number,
    notConfirmedBefore: Date,
  ): Promise<Transaction[]> {
    const confirmed = [...this.transactions.values()]
      .filter(
        (transaction) =>
          transaction.chain === chain &&
          transaction.status === 'CONFIRMED' &&
          (transaction.confirmedAt?.getTime() ?? 0) >= notConfirmedBefore.getTime(),
      )
      .sort((a, b) => (a.confirmedAt?.getTime() ?? 0) - (b.confirmedAt?.getTime() ?? 0))
      .slice(0, limit);

    return Promise.resolve(confirmed);
  }

  recordBroadcast(transactionId: string, hash: string, error?: DispatchError): Promise<void> {
    return this.settle(() => {
      const transaction = this.requireTransaction(transactionId);
      if (transaction.hash !== hash) {
        throw new Error(
          `recordBroadcast hash mismatch for ${transactionId}: a re-broadcast must be of the ` +
            `Transaction's exact signed bytes (CONTEXT.md), so its hash can't change. Changed ` +
            `bytes are a new Transaction, not a new Attempt of this one.`,
        );
      }
      this.attempts.get(transactionId)?.push({
        id: randomUUID(),
        transactionId,
        broadcastAt: new Date(),
        error: error ?? null,
      });
      this.transactions.set(transactionId, { ...transaction, lastBroadcastAt: this.now() });
    });
  }

  createReplacementTransaction(
    predecessorId: string,
    replacement: { signedBytes: string; hash: string },
  ): Promise<Transaction> {
    const predecessor = this.transactions.get(predecessorId);
    if (!predecessor) return Promise.reject(new Error(`Unknown transaction: ${predecessorId}`));

    const now = this.now();
    const transaction: Transaction = {
      ...predecessor,
      id: randomUUID(),
      signedBytes: replacement.signedBytes,
      hash: replacement.hash,
      status: 'PENDING',
      error: null,
      broadcastAt: now,
      abandonedAt: null,
      confirmedAt: null,
      lastCheckedAt: null,
      lastBroadcastAt: now,
      replacesTransactionId: predecessor.id,
      feeBumpAttempts: predecessor.feeBumpAttempts + 1,
    };
    this.transactions.set(transaction.id, transaction);
    this.attempts.set(transaction.id, []);
    this.transactions.set(predecessorId, { ...predecessor, status: 'REPLACED' });
    return Promise.resolve(transaction);
  }

  listTransactionsByHash(hash: string): Promise<Transaction[]> {
    return Promise.resolve([...this.transactions.values()].filter((t) => t.hash === hash));
  }

  setFeeBumpAttempts(transactionId: string, feeBumpAttempts: number): Promise<void> {
    return this.settle(() => {
      const transaction = this.requireTransaction(transactionId);
      this.transactions.set(transactionId, { ...transaction, feeBumpAttempts });
    });
  }

  recordSent(transactionId: string, hash: string): Promise<void> {
    return this.settle(() => {
      const transaction = this.requireTransaction(transactionId);
      this.transactions.set(transactionId, { ...transaction, hash, lastBroadcastAt: this.now() });
    });
  }

  undoReplacement(replacementId: string): Promise<void> {
    return this.settle(() => {
      const replacement = this.requireTransaction(replacementId);
      if (!replacement.replacesTransactionId)
        throw new Error(`Not a replacement transaction: ${replacementId}`);
      const predecessor = this.requireTransaction(replacement.replacesTransactionId);
      this.transactions.set(replacementId, { ...replacement, status: 'DROPPED' });
      this.transactions.set(predecessor.id, { ...predecessor, status: 'PENDING' });
    });
  }

  reclaimStaleDispatches(
    chains: ChainScope,
    claimedBefore: Date,
    limit: number,
  ): Promise<Dispatch[]> {
    const stale = [...this.dispatches.values()]
      .filter((dispatch) => {
        const claimed = this.claimedAt.get(dispatch.id);
        if (
          dispatch.status !== 'broadcasting' ||
          !chains.includes(dispatch.chain) ||
          !claimed ||
          claimed >= claimedBefore
        )
          return false;
        const sent = new Set(
          [...this.transactions.values()]
            .filter((t) => t.dispatchId === dispatch.id)
            .map((t) => t.callIndex),
        );
        return sent.size < dispatch.items.length;
      })
      .slice(0, limit);
    for (const dispatch of stale) this.claimedAt.set(dispatch.id, this.now());
    return Promise.resolve(stale);
  }

  reclaimStaleRelayDispatches(
    chains: ChainScope,
    claimedBefore: Date,
    limit: number,
  ): Promise<RelayDispatch[]> {
    const stale = [...this.relayDispatches.values()]
      .filter((relay) => {
        if (!chains.includes(relay.chain)) return false;
        const claimed = this.claimedAt.get(relay.id);
        // No Transaction row at all — not merely an unwritten link (a crash between the two writes).
        const hasTransaction = [...this.transactions.values()].some(
          (t) => t.dispatchId === relay.id,
        );
        return (
          relay.status === 'broadcasting' && !hasTransaction && !!claimed && claimed < claimedBefore
        );
      })
      .slice(0, limit);
    for (const relay of stale) this.claimedAt.set(relay.id, this.now());
    return Promise.resolve(stale);
  }

  countWaitingWork(chains: ChainScope): Promise<Map<Chain, number>> {
    const waiting = [
      ...[...this.dispatches.values()].filter((d) => d.status === 'queued'),
      ...[...this.relayDispatches.values()].filter((r) => r.status === 'queued'),
      ...[...this.transactions.values()].filter(
        (t) =>
          t.status === 'PENDING' || t.status === 'UNPROPOSED' || t.status === 'AWAITING_APPROVAL',
      ),
    ];
    const counts = new Map<Chain, number>();
    for (const { chain } of waiting) {
      if (chains.includes(chain)) counts.set(chain, (counts.get(chain) ?? 0) + 1);
    }
    return Promise.resolve(counts);
  }

  markDropped(transactionId: string): Promise<void> {
    return this.settle(() => {
      const transaction = this.requireTransaction(transactionId);
      this.transactions.set(transactionId, { ...transaction, status: 'DROPPED' });
    });
  }

  markAbandoned(transactionId: string, error?: DispatchError): Promise<void> {
    return this.settle(() => {
      const transaction = this.requireTransaction(transactionId);
      this.transactions.set(transactionId, {
        ...transaction,
        status: 'ABANDONED',
        abandonedAt: this.now(),
        ...(error ? { error } : {}),
      });
    });
  }

  markFailed(transactionId: string, error: DispatchError): Promise<void> {
    return this.settle(() => {
      const transaction = this.requireTransaction(transactionId);
      this.transactions.set(transactionId, { ...transaction, status: 'FAILED', error });
    });
  }

  markConfirmed(transactionId: string): Promise<void> {
    return this.settle(() => {
      const transaction = this.requireTransaction(transactionId);
      this.transactions.set(transactionId, {
        ...transaction,
        status: 'CONFIRMED',
        confirmedAt: this.now(),
      });
    });
  }

  reopenTransaction(transactionId: string): Promise<void> {
    return this.settle(() => {
      const transaction = this.requireTransaction(transactionId);
      this.transactions.set(transactionId, {
        ...transaction,
        status: 'PENDING',
        confirmedAt: null,
      });
    });
  }

  createRelayDispatch<C extends Chain>(input: NewRelayDispatchInput<C>): Promise<RelayDispatch<C>> {
    const existing = [...this.relayDispatches.values()].find(
      (relayDispatch) => relayDispatch.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      return Promise.resolve(existing as RelayDispatch<C>);
    }

    const relayDispatch: RelayDispatch<C> = {
      id: randomUUID(),
      chain: input.chain,
      idempotencyKey: input.idempotencyKey,
      signedTransaction: input.signedTransaction,
      status: 'queued',
      transactionId: null,
    };
    this.relayDispatches.set(relayDispatch.id, relayDispatch);

    return Promise.resolve(relayDispatch);
  }

  getRelayDispatch(id: string): Promise<RelayDispatch | null> {
    return Promise.resolve(this.relayDispatches.get(id) ?? null);
  }

  claimQueuedRelayDispatches(chains: ChainScope, limit: number): Promise<RelayDispatch[]> {
    const claimed: RelayDispatch[] = [];
    for (const relayDispatch of this.relayDispatches.values()) {
      if (claimed.length >= limit) break;
      if (relayDispatch.status !== 'queued' || !chains.includes(relayDispatch.chain)) continue;

      const broadcasting: RelayDispatch = { ...relayDispatch, status: 'broadcasting' };
      this.relayDispatches.set(relayDispatch.id, broadcasting);
      this.claimedAt.set(relayDispatch.id, this.now());
      claimed.push(broadcasting);
    }

    return Promise.resolve(claimed);
  }

  setRelayDispatchTransaction(relayDispatchId: string, transactionId: string): Promise<void> {
    return this.settle(() => {
      const relayDispatch = this.relayDispatches.get(relayDispatchId);
      if (!relayDispatch) {
        throw new Error(`Unknown relay dispatch: ${relayDispatchId}`);
      }
      this.relayDispatches.set(relayDispatchId, { ...relayDispatch, transactionId });
    });
  }

  noteUnproposed(inputs: NewUnproposedInput[]): Promise<Transaction[]> {
    const noted: Transaction[] = [];
    for (const input of inputs) {
      const existing = [...this.transactions.values()].find(
        (t) => t.dispatchId === input.dispatchId && t.callIndex === input.callIndex,
      );
      if (existing) {
        noted.push(existing);
        continue;
      }
      const transaction: Transaction = {
        id: randomUUID(),
        dispatchId: input.dispatchId,
        callIndex: input.callIndex,
        chain: input.chain,
        hash: null,
        signedBytes: null,
        status: 'UNPROPOSED',
        error: null,
        broadcastAt: null,
        abandonedAt: null,
        confirmedAt: null,
        lastCheckedAt: null,
        lastBroadcastAt: null,
        replacesTransactionId: null,
        feeBumpAttempts: 0,
        proposalId: null,
        proposalPosition: null,
      };
      this.transactions.set(transaction.id, transaction);
      this.attempts.set(transaction.id, []);
      noted.push(transaction);
    }
    return Promise.resolve(noted);
  }

  listUnproposed(chain: Chain, limit: number): Promise<Transaction[]> {
    const dispatchOrder = new Map([...this.dispatches.keys()].map((id, index) => [id, index]));
    const unproposed = [...this.transactions.values()]
      .filter((t) => t.status === 'UNPROPOSED' && t.chain === chain)
      .sort(
        (a, b) =>
          (dispatchOrder.get(a.dispatchId) ?? 0) - (dispatchOrder.get(b.dispatchId) ?? 0) ||
          a.callIndex - b.callIndex,
      )
      .slice(0, limit);
    return Promise.resolve(unproposed);
  }

  createProposal(input: NewProposalInput): Promise<Proposal> {
    return this.settleWith(() => {
      const calls = input.transactionIds.map((id) => this.requireTransaction(id));
      if (calls.length === 0) throw new Error('A Proposal needs at least one Transaction');
      if (new Set(input.transactionIds).size !== calls.length) {
        throw new Error('A Proposal cannot hold the same Transaction twice');
      }
      for (const call of calls) {
        if (call.status !== 'UNPROPOSED') {
          throw new Error(`Transaction ${call.id} is ${call.status}, not UNPROPOSED`);
        }
        if (call.dispatchId !== input.dispatchId || call.chain !== input.chain) {
          throw new Error(
            `Transaction ${call.id} is not of Dispatch ${input.dispatchId} on ${input.chain}: a Proposal never mixes Dispatches`,
          );
        }
      }
      for (const other of this.proposals.values()) {
        if (other.proposalRef === input.proposalRef) {
          throw new Error(`proposalRef ${input.proposalRef} is already in use`);
        }
        if (
          input.chain === 'solana' &&
          input.sequence !== null &&
          other.chain === input.chain &&
          other.senderAddress === input.senderAddress &&
          other.sequence === input.sequence
        ) {
          throw new Error(
            `sequence ${input.sequence} is already in use for ${input.senderAddress}`,
          );
        }
      }

      const now = this.now();
      const { transactionIds, ...fields } = input;
      const proposal: Proposal = {
        ...fields,
        id: randomUUID(),
        phase: 'noted',
        approvalState: 'awaiting',
        approvals: 0,
        timedOutAt: null,
        resolvedAt: null,
        createdAt: now,
        nextCheckAt: now,
        checkFailures: 0,
      };
      this.proposals.set(proposal.id, proposal);
      transactionIds.forEach((id, position) => {
        const call = this.requireTransaction(id);
        this.transactions.set(id, {
          ...call,
          status: 'AWAITING_APPROVAL',
          proposalId: proposal.id,
          proposalPosition: position,
        });
      });
      return proposal;
    });
  }

  getProposal(id: string): Promise<Proposal | null> {
    return Promise.resolve(this.proposals.get(id) ?? null);
  }

  countOpenProposals(chain: Chain, senderAddress: string): Promise<number> {
    const open = [...this.proposals.values()].filter(
      (p) =>
        p.chain === chain &&
        p.senderAddress === senderAddress &&
        (p.phase === 'noted' || p.phase === 'open' || p.phase === 'executing'),
    );
    return Promise.resolve(open.length);
  }

  hasNotedProposal(chain: Chain, senderAddress: string): Promise<boolean> {
    return Promise.resolve(
      [...this.proposals.values()].some(
        (p) => p.chain === chain && p.senderAddress === senderAddress && p.phase === 'noted',
      ),
    );
  }

  listProposalsDue(chains: ChainScope, now: Date, limit: number): Promise<Proposal[]> {
    const due = [...this.proposals.values()]
      .filter(
        (p) =>
          p.phase !== 'resolved' &&
          chains.includes(p.chain) &&
          p.nextCheckAt.getTime() <= now.getTime(),
      )
      .sort((a, b) => a.nextCheckAt.getTime() - b.nextCheckAt.getTime())
      .slice(0, limit);
    return Promise.resolve(due);
  }

  listProposalCalls(proposalId: string): Promise<Transaction[]> {
    return Promise.resolve(this.currentProposalCalls(proposalId));
  }

  updateProposal(id: string, patch: ProposalPatch): Promise<Proposal> {
    return this.settleWith(() => {
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const updated = { ...this.requireProposal(id), ...defined };
      this.proposals.set(id, updated);
      return updated;
    });
  }

  markProposalExecuting(
    proposalId: string,
    signedBytes: string,
    hash: string,
  ): Promise<Transaction[]> {
    return this.settleWith(() => {
      const proposal = this.requireProposal(proposalId);
      const calls = this.currentProposalCalls(proposalId);
      if (calls.length === 0 || calls.some((c) => c.status !== 'AWAITING_APPROVAL')) {
        throw new Error(`Proposal ${proposalId} has Calls that are not AWAITING_APPROVAL`);
      }
      const now = this.now();
      this.proposals.set(proposalId, { ...proposal, phase: 'executing' });
      return calls.map((call) => {
        const executing: Transaction = {
          ...call,
          status: 'PENDING',
          hash,
          signedBytes,
          broadcastAt: now,
          lastBroadcastAt: now,
        };
        this.transactions.set(call.id, executing);
        return executing;
      });
    });
  }

  reopenProposalForExecution(proposalId: string): Promise<Transaction[]> {
    return this.settleWith(() => {
      const proposal = this.requireProposal(proposalId);
      const calls = this.currentProposalCalls(proposalId);
      if (
        calls.length === 0 ||
        calls.some((c) => c.status !== 'FAILED' && c.status !== 'PENDING')
      ) {
        throw new Error(`Proposal ${proposalId} has Calls that are neither PENDING nor FAILED`);
      }
      this.proposals.set(proposalId, { ...proposal, phase: 'open', nextCheckAt: this.now() });
      return calls.map((call) => {
        const reopened: Transaction = {
          ...call,
          status: 'AWAITING_APPROVAL',
          hash: null,
          signedBytes: null,
          error: null,
          broadcastAt: null,
          lastBroadcastAt: null,
        };
        this.transactions.set(call.id, reopened);
        return reopened;
      });
    });
  }

  settleProposal(proposalId: string, outcome: ProposalOutcome): Promise<Transaction[]> {
    return this.settleWith(() => {
      const proposal = this.requireProposal(proposalId);
      const now = this.now();
      const settled = this.currentProposalCalls(proposalId).map((call) => {
        const next: Transaction = {
          ...call,
          status: outcome.status,
          error: outcome.error ?? null,
          hash: outcome.hash === undefined ? call.hash : outcome.hash,
          ...(outcome.status === 'CONFIRMED' ? { confirmedAt: now } : {}),
          ...(outcome.status === 'ABANDONED' ? { abandonedAt: now } : {}),
        };
        this.transactions.set(call.id, next);
        return next;
      });
      this.proposals.set(
        proposalId,
        outcome.status === 'ABANDONED'
          ? { ...proposal, phase: 'timed_out', timedOutAt: now }
          : { ...proposal, phase: 'resolved', resolvedAt: now },
      );
      return settled;
    });
  }

  listCommitted(
    chain: Chain,
    holder: CommittedHolder,
    timedOutSince: Date,
  ): Promise<AssetAmount[]> {
    const proposals = [...this.proposals.values()].filter(
      (p) => p.chain === chain && holdsCommitment(p, timedOutSince),
    );
    const unproposedPayments = [...this.transactions.values()]
      .filter((t) => t.chain === chain && t.status === 'UNPROPOSED')
      .map((t) => this.dispatches.get(t.dispatchId)?.items[t.callIndex]?.payment ?? null);
    return Promise.resolve(totalCommitted(holder, proposals, unproposedPayments));
  }

  listProposalsForDispatch(dispatchId: string): Promise<Proposal[]> {
    return Promise.resolve(
      [...this.proposals.values()]
        .filter((p) => p.dispatchId === dispatchId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }

  /** Test-only inspection — not part of DispatchStore. */
  getTransaction(transactionId: string): Transaction | null {
    return this.transactions.get(transactionId) ?? null;
  }

  /** Test-only inspection — not part of DispatchStore. Creation order. */
  listAllTransactions(): Transaction[] {
    return [...this.transactions.values()];
  }

  /** Test-only inspection — not part of DispatchStore. */
  getAttempts(transactionId: string): Attempt[] {
    return this.attempts.get(transactionId) ?? [];
  }

  private requireTransaction(transactionId: string): Transaction {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      throw new Error(`Unknown transaction: ${transactionId}`);
    }
    return transaction;
  }

  private requireProposal(proposalId: string): Proposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Unknown proposal: ${proposalId}`);
    }
    return proposal;
  }

  /** A Proposal's Calls in position order, current versions only. */
  private currentProposalCalls(proposalId: string): Transaction[] {
    return [...this.transactions.values()]
      .filter(
        (t) => t.proposalId === proposalId && t.status !== 'REPLACED' && t.status !== 'DROPPED',
      )
      .sort((a, b) => (a.proposalPosition ?? 0) - (b.proposalPosition ?? 0));
  }

  /** Like `settle`, for a body that returns a value. All-or-nothing is the body's job: it must validate before it writes. */
  private settleWith<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Runs a synchronous body, turning a thrown error into a rejected Promise — matching what an `async` real implementation does automatically, so a Coordinator's error handling behaves the same against the fake and against Postgres. */
  private settle(fn: () => void): Promise<void> {
    try {
      fn();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
