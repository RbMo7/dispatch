import type { Chain } from '../domain/chain.js';

export type NonceHistoryRecord = {
  chain: Chain;
  senderAddress: string;
  nonce: number;
  hash: string;
};

/**
 * base-chain-handler issue 02 (ADR-0011): a small, domain-shaped seam for a
 * per-(chain, signing address) nonce->hash history — the Sender's own, plus
 * any Relay Dispatch signer's, recovered from its bytes (#13) — kept separate from DispatchStore
 * since it's Chain-Handler-internal bookkeeping, not Dispatch/Transaction
 * orchestration state the Coordinator itself needs. Populated by
 * BaseChainHandler.broadcast (issue 03) on every successful broadcast —
 * including a fee-bump replacement, which reuses the same nonce (CONTEXT.md's
 * Attempt-vs-Transaction split), so `recordNonce` for an already-recorded
 * (chain, senderAddress, nonce) is a no-op, not an error. Consumed by no
 * logic yet — groundwork for the deferred EVM analogue of ADR-0030.
 */
export interface NonceHistoryStore {
  recordNonce(record: NonceHistoryRecord): Promise<void>;
  /** Ascending by nonce — the shape a future higher-nonce-confirmed proof would scan. */
  listNonceHistory(chain: Chain, senderAddress: string): Promise<NonceHistoryRecord[]>;
}
