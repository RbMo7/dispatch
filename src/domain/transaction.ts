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
export type TransactionStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'ABANDONED'
  /** #9 (ADR-0037): a newer fee-bump replacement exists at the same nonce. Still watched — this version may be the one that lands — but never a Call's reported status. */
  | 'REPLACED'
  /** #9 (ADR-0037): another version at the same nonce settled the Call, so this one can never land. Terminal, never a Call's reported status. */
  | 'DROPPED';

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
  /** When this Transaction was first broadcast — null exactly when hash/signedBytes are (never broadcast). What the ABANDONED timeout (ADR-0004) measures elapsed time against. */
  broadcastAt: Date | null;
  /** When this Transaction was marked ABANDONED — null unless status is (or once was) ABANDONED. What the low-frequency re-watch's bounded window (issue 10, ADR-0004) measures elapsed time against; a CONFIRMED/FAILED transaction that was previously re-watched keeps this set, a harmless historical fact once it's no longer ABANDONED. */
  abandonedAt: Date | null;
  /**
   * base-chain-handler issue 07: when this Transaction was last marked
   * CONFIRMED — null unless status is (or once was) CONFIRMED. What the
   * reorg safety net's bounded re-check window measures elapsed time
   * against, mirroring `abandonedAt`'s own shape; cleared by `reopenTransaction`
   * (a re-check that found the receipt gone), set again if it later re-confirms.
   */
  confirmedAt: Date | null;
  /** #21: when the pending poll last picked this Transaction up — null until its first poll. What `listPendingTransactions` rotates on, so rows that stay PENDING can't starve newer ones. */
  lastCheckedAt: Date | null;
  /** #9: when these exact signed bytes were last sent — first broadcast or a later rebroadcast Attempt. What the stuck timer (ADR-0037) measures against. */
  lastBroadcastAt: Date | null;
  /** #9: the fee-bumped predecessor this Transaction replaced, at the same nonce — null for an original. */
  replacesTransactionId: string | null;
  /** #9: fee-bump attempts made for this Call so far, failed ones included — carried onto each replacement; bumping stops at the chain's cap. */
  feeBumpAttempts: number;
};

/** One broadcast/confirmation-check of a Transaction's exact signed bytes. */
export type Attempt = {
  id: string;
  transactionId: string;
  broadcastAt: Date;
  error: DispatchError | null;
};
