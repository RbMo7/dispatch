import type { Chain } from '../domain/chain.js';

export type NonceRange = { from: number; to: number };

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
 * BaseChainHandler.broadcast (issue 03) on every broadcast that may have reached the node —
 * including a fee-bump replacement, which reuses the same nonce (CONTEXT.md's
 * Attempt-vs-Transaction split), so `recordNonce` for an already-recorded
 * (chain, senderAddress, nonce) is a no-op, not an error. A send that may
 * have reached the node is recorded too (#172), so every nonce this engine
 * may have used is here: ADR-0064's detection reads the rest as another
 * sender's.
 */
export interface NonceHistoryStore {
  recordNonce(record: NonceHistoryRecord): Promise<void>;
  /** Ascending by nonce. With `range`, only nonces in [from, to): what #172 compares with the chain (ADR-0064). */
  listNonceHistory(
    chain: Chain,
    senderAddress: string,
    range?: NonceRange,
  ): Promise<NonceHistoryRecord[]>;
}
