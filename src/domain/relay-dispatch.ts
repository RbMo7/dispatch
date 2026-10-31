import type { Chain } from './chain.js';

/**
 * Only the states this record itself ever persists directly
 * (ADR-0009's outbox transition, mirrored from Dispatch's own status field,
 * plus ADR-0056's `cancelled`)
 * — the terminal wire status (confirmed/failed/abandoned) is derived at read
 * time from the linked Transaction, once `transactionId` is set, exactly
 * like a Managed Dispatch's per-item status.
 */
export type RelayDispatchStatus = 'queued' | 'broadcasting' | 'cancelled';

/**
 * ADR-0031: a Relay Dispatch's own domain type — never a `Dispatch`/
 * `DispatchItem` variant, since it's always exactly one already-signed
 * transaction, with no batch to aggregate and no `retryPolicy` (there's no
 * key for the engine to fee-bump with). `signedTransaction` is the same
 * opaque `SignedTransaction` string `ChainHandler.broadcast` consumes
 * (ADR-0027) — plain `string` here, matching how `Transaction.signedBytes`
 * is typed in this same domain layer. `transactionId` is null until the
 * Coordinator's single broadcast attempt resolves, success or failure
 * alike (both paths produce an ordinary `Transaction` row, reused
 * unchanged).
 */
export type RelayDispatch<C extends Chain = Chain> = {
  id: string;
  chain: C;
  /** Required (ADR-0021) — scoped to Relay Dispatch's own table, never shared with Managed Dispatch's idempotency-key space (ADR-0031: its own table, never squeezed into `dispatches`). */
  idempotencyKey: string;
  signedTransaction: string;
  status: RelayDispatchStatus;
  transactionId: string | null;
  createdAt: Date;
  /** #20: when a worker last claimed it. */
  claimedAt: Date | null;
  /** ADR-0056: set exactly when `status` is `cancelled`. */
  cancelledAt: Date | null;
};
