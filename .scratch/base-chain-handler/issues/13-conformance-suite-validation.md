Status: ready-for-agent

# 13: Conformance suite validation

**What to build:** `BaseChainHandler` runs the exact shared `ChainHandler` conformance suite `SolanaChainHandler` already passes (ADR-0015) — including the `validateSignedTransaction`/broadcast-bookkeeping cases the suite already gained from Relay Dispatch's design pass — with no Base-specific carve-outs or a forked suite.

**Blocked by:** 05 (smart contract call submission), 07 (reorg safety net), 08 (ABANDONED timeout), 09 (fee-bump retry), 10 (error mapping), 11 (Bulk Call), 12 (Relay Dispatch validate and bookkeeping).

**Status:** ready-for-agent

- [ ] `BaseChainHandler` is added as a second implementation the shared conformance suite runs against, alongside `SolanaChainHandler`
- [ ] Every existing conformance case passes for Base with no skipped/`.todo` tests and no Base-specific exceptions carved into the suite itself
- [ ] Any suite gap the Base implementation surfaces (a case Solana's shape happened to make untestable, or an assumption the suite baked in that isn't actually chain-agnostic) is fixed in the shared suite, not worked around locally in Base's own tests
