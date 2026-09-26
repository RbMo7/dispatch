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
 * BaseChainHandler.sign (#20: before sending, ADR-0041) and .broadcast —
 * including a fee-bump replacement, which reuses the same nonce (CONTEXT.md's
 * Attempt-vs-Transaction split), so `recordNonce` for an already-recorded
 * (chain, senderAddress, nonce) is a no-op, not an error. Consumed by no
 * logic yet — groundwork for the deferred EVM analogue of ADR-0030.
 */
export interface NonceHistoryStore {
  recordNonce(record: NonceHistoryRecord): Promise<void>;
  /** Ascending by nonce — the shape a future higher-nonce-confirmed proof would scan. */
  listNonceHistory(chain: Chain, senderAddress: string): Promise<NonceHistoryRecord[]>;
  /** #20 (ADR-0041): the highest nonce ever recorded for this signer, or null — what a restarted handler seeds past, so a nonce written down but never sent stays reserved. */
  highestNonce(chain: Chain, senderAddress: string): Promise<number | null>;
  /** #20: a nonce was handed back (ADR-0039) — forget it, so it doesn't hold up seeding and can be recorded afresh when reused. */
  forgetNonce(chain: Chain, senderAddress: string, nonce: number): Promise<void>;
}
