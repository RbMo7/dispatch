import { randomUUID } from 'node:crypto';

import type { Chain } from '../domain/chain.js';
import type { Dispatch } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { Attempt, Transaction } from '../domain/transaction.js';
import type {
  DispatchStore,
  NewDispatchInput,
  NewFailedCallInput,
  NewTransactionInput,
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

  claimQueued(limit: number): Promise<Dispatch[]> {
    const claimed: Dispatch[] = [];
    for (const dispatch of this.dispatches.values()) {
      if (claimed.length >= limit) break;
      if (dispatch.status !== 'queued') continue;

      const broadcasting: Dispatch = { ...dispatch, status: 'broadcasting' };
      this.dispatches.set(dispatch.id, broadcasting);
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
    };
    this.transactions.set(transaction.id, transaction);
    this.attempts.set(transaction.id, []);

    return Promise.resolve(transaction);
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
    };
    this.transactions.set(transaction.id, transaction);
    this.attempts.set(transaction.id, []);

    return Promise.resolve(transaction);
  }

  listPendingTransactions(limit: number): Promise<Transaction[]> {
    const pending = [...this.transactions.values()]
      .filter((transaction) => transaction.status === 'PENDING')
      .sort((a, b) => (a.broadcastAt?.getTime() ?? 0) - (b.broadcastAt?.getTime() ?? 0))
      .slice(0, limit);

    return Promise.resolve(pending);
  }

  recordBroadcast(transactionId: string, hash: string): Promise<void> {
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
        error: null,
      });
    });
  }

  markAbandoned(transactionId: string): Promise<void> {
    return this.settle(() => {
      const transaction = this.requireTransaction(transactionId);
      this.transactions.set(transactionId, { ...transaction, status: 'ABANDONED' });
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
      this.transactions.set(transactionId, { ...transaction, status: 'CONFIRMED' });
    });
  }

  /** Test-only inspection — not part of DispatchStore. */
  getTransaction(transactionId: string): Transaction | null {
    return this.transactions.get(transactionId) ?? null;
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
