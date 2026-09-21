import type { CallForChain } from './call.js';
import type { Chain } from './chain.js';

/** Lowercase to mirror the wire enum pinned in docs/api.md verbatim. */
export type DispatchStatus = 'queued' | 'broadcasting' | 'confirmed' | 'failed' | 'partial';

/**
 * A Dispatch's items are always Call (ADR-0018) — a Payment submitted on the
 * wire is translated into a Call at the API layer before a Dispatch is ever
 * formed, so nothing downstream needs a special case for where an item came
 * from. Parameterized over C so a Dispatch's `chain` and its items' shape
 * can never disagree: `Dispatch<'solana'>`'s items are SolanaCall, never
 * EvmCall.
 */
export type Dispatch<C extends Chain = Chain> = {
  id: string;
  chain: C;
  /** Required on every Dispatch (ADR-0021) — a plain unique string, scoped globally. */
  idempotencyKey: string;
  items: CallForChain<C>[];
  status: DispatchStatus;
};
