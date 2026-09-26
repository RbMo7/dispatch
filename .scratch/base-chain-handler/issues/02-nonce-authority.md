Status: ready-for-agent

# 02: Nonce authority

**What to build:** `BaseChainHandler` owns the next-nonce assignment for its single configured Sender (ADR-0016's current single-Sender scope) rather than trusting a per-request RPC read, so concurrent Managed Dispatch submissions never collide on the same nonce or leave a gap. The counter initializes from `eth_getTransactionCount(sender, "latest")` on construction and resyncs the same way if a broadcast ever fails with a nonce-mismatch-shaped error. Every successful broadcast (built by a later ticket) will append to a persisted per-Sender nonce→transaction-hash history — this ticket lays that storage down even though nothing reads it yet (the byproduct decision behind the deferred EVM analogue of ADR-0030).

**Blocked by:** 01 (chain plumbing & config).

**Status:** ready-for-agent

- [ ] `BaseChainHandler` exposes an internal next-nonce assignment path used by `prepare` (built in ticket 03) — no RPC call happens per assignment
- [ ] The counter is initialized from real Base Sepolia via `eth_getTransactionCount` on construction
- [ ] Two nonce assignments requested back-to-back (no broadcast in between) return sequential, non-colliding values
- [ ] A resync path exists that re-reads `eth_getTransactionCount` and corrects the internal counter if it's ever found to have drifted
- [ ] A persisted per-Sender nonce→transaction-hash record store exists (schema/interface only — populated once broadcast exists in ticket 03, consumed by no logic yet)
