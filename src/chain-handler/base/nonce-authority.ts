/**
 * issue 02: the single in-process next-nonce authority for one Sender
 * (ADR-0002's single-nonce-authority requirement) — pulled out as its own
 * pure, no-RPC class so it's directly unit-testable without a real
 * BaseChainHandler/RPC connection, mirroring how solana-chain-handler
 * splits its own no-I/O concerns into dedicated modules.
 *
 * `assignNext` never awaits anything, so nothing can interleave between
 * its read and increment even under concurrent async callers — the same
 * reasoning ADR-0002 applies to why this counter, not a per-request
 * `eth_getTransactionCount("pending")` read, has to be the one authority.
 */
export class NonceCounter {
  private nextNonce: number;

  constructor(initialNonce: number) {
    this.nextNonce = initialNonce;
  }

  /** The only way anything may assign a nonce — never a direct read of the counter. */
  assignNext(): number {
    return this.nextNonce++;
  }

  /** issue 02: corrects the counter after it's found to have drifted (a nonce-mismatch-shaped broadcast failure, or a fresh process resuming an existing Sender). */
  resyncTo(latestFromChain: number): void {
    this.nextNonce = latestFromChain;
  }

  /**
   * The chain says a nonce we used was already consumed, so it is ahead of
   * what we thought. Moves forward only: the confirmed count can lag
   * transactions still in flight at higher nonces, and moving back onto
   * one of those would build a second transaction at an in-flight nonce,
   * silently replacing a different Call's transaction.
   */
  advanceTo(confirmedFromChain: number): void {
    this.nextNonce = Math.max(this.nextNonce, confirmedFromChain);
  }

  /** The next value `assignNext` would hand out — read-only inspection, never itself an assignment. */
  peek(): number {
    return this.nextNonce;
  }
}
