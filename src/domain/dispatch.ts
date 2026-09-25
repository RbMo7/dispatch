import type { DispatchItem } from './call.js';
import type { Chain } from './chain.js';

/** Lowercase to mirror the wire enum pinned in docs/api.md verbatim. */
export type DispatchStatus = 'queued' | 'broadcasting' | 'confirmed' | 'failed' | 'partial';

/**
 * A Dispatch's items are always Call, paired with the Payment each came
 * from where one exists (ADR-0018/ADR-0024's DispatchItem) — a Payment
 * submitted on the wire is translated into a Call at the API layer before
 * a Dispatch is ever formed, so nothing downstream needs a special case for
 * where an item came from, except the Funding Check reading `payment` back
 * out. Parameterized over C so a Dispatch's `chain` and its items' Call
 * shape can never disagree: `Dispatch<'solana'>`'s items carry SolanaCall,
 * never EvmCall.
 */
export type Dispatch<C extends Chain = Chain> = {
  id: string;
  chain: C;
  /** Required on every Dispatch (ADR-0021) — a plain unique string, scoped globally. */
  idempotencyKey: string;
  items: DispatchItem<C>[];
  status: DispatchStatus;
  /**
   * Whether the Coordinator may fee-bump a stuck transaction instead of
   * marking it ABANDONED after its chain-aware timeout (ADR-0003/0004).
   * Defaults off; already resolved (request value or the operator's global
   * default) by the time a Dispatch is created — the Coordinator just
   * reads it.
   */
  retryPolicy: boolean;
  /** #11 (ADR-0038): opted into Bulk Call — items go out as `aggregate3Value` chunks through this caller-named aggregator. Null for the default one-transaction-per-item mode. */
  bulkCall: BulkCall | null;
};

/** #11 (ADR-0038): a request's Bulk Call opt-in, as resolved at the API edge (`maxBatchSize` already defaulted and bounded). */
export type BulkCall = {
  aggregator: string;
  maxBatchSize: number;
};
