import type { Chain } from './chain.js';
import type { DispatchError } from './errors.js';

/**
 * ABANDONED is distinct from FAILED (ADR-0004): FAILED means the chain itself
 * rejected or reverted the transaction; ABANDONED means the engine stopped
 * actively tracking it without a definitive outcome. Uppercase to match
 * CONTEXT.md/ADR-0004's own vocabulary for these terms; unlike DispatchStatus
 * this isn't a wire literal pinned anywhere yet, so it isn't required to
 * match the API's casing.
 */
export type TransactionStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'ABANDONED';

/**
 * One broadcastable, chain-native unit with its own hash/signature
 * (CONTEXT.md). Resubmitting its exact signedBytes is a new Attempt of the
 * same Transaction; changing the signed bytes (a fee-bump, a refreshed
 * blockhash) is a new Transaction.
 */
export type Transaction = {
  id: string;
  dispatchId: string;
  /** Position of the Call within its Dispatch's items this Transaction executes. */
  callIndex: number;
  chain: Chain;
  /** Null exactly when the Call never reached a broadcast (e.g. failed validateCall/prepare/sign) — docs/api.md's own failed-item example shows `transactionHash: null` for this case. */
  hash: string | null;
  signedBytes: string | null;
  status: TransactionStatus;
  /** Structured reason (ADR-0010) once status is FAILED or ABANDONED; null otherwise. */
  error: DispatchError | null;
};

/** One broadcast/confirmation-check of a Transaction's exact signed bytes. */
export type Attempt = {
  id: string;
  transactionId: string;
  broadcastAt: Date;
  error: DispatchError | null;
};
