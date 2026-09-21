import type { CallForChain } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { Dispatch } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { Transaction } from '../domain/transaction.js';

export type NewDispatchInput<C extends Chain = Chain> = {
  chain: C;
  idempotencyKey: string;
  items: CallForChain<C>[];
};

export type NewTransactionInput = {
  dispatchId: string;
  /** Position of the Call within its Dispatch's items this Transaction executes. */
  callIndex: number;
  chain: Chain;
  signedBytes: string;
  hash: string;
};

/**
 * The Coordinator's — and the API's — only way to touch persistence
 * (ADR-0011): a small, domain-shaped seam so orchestration logic can be
 * tested against InMemoryDispatchStore instead of a real database.
 */
export interface DispatchStore {
  /** Idempotent create (ADR-0021): resubmitting an existing idempotencyKey returns the original Dispatch. */
  createDispatch<C extends Chain>(input: NewDispatchInput<C>): Promise<Dispatch<C>>;
  getDispatch(id: string): Promise<Dispatch | null>;
  /** All Transactions created so far for a Dispatch's Calls — what a status response (docs/api.md) is built from. */
  listTransactions(dispatchId: string): Promise<Transaction[]>;
  /** Atomically claims up to `limit` queued Dispatches for the worker to process (ADR-0009). */
  claimQueued(limit: number): Promise<Dispatch[]>;
  /** Persists a Call's freshly-signed Transaction, once broadcast for the first time. */
  createTransaction(input: NewTransactionInput): Promise<Transaction>;
  /** Records a re-broadcast of a Transaction's exact signed bytes — a new Attempt of the same Transaction. */
  recordBroadcast(transactionId: string, hash: string): Promise<void>;
  markAbandoned(transactionId: string): Promise<void>;
  markFailed(transactionId: string, error: DispatchError): Promise<void>;
  markConfirmed(transactionId: string): Promise<void>;
}
