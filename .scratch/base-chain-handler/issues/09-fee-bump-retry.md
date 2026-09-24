Status: ready-for-agent

# 09: Fee-bump retry

**What to build:** Retry Policy's EVM shape (ADR-0003): when a Managed Dispatch opts in and a Base transaction is stuck, the engine builds a *new* Transaction at the same nonce with both `maxFeePerGas` and `maxPriorityFeePerGas` raised by an operator-configurable percentage (documented default noted as go-ethereum/op-geth's own inherited 10% floor plus margin, explicitly not claimed as a verified Base-sequencer guarantee). A fee-bump is never a mutation of the original Transaction's fields (CONTEXT.md's Attempt-vs-Transaction split).

**Blocked by:** 06 (status and confirmation tracking).

**Status:** ready-for-agent

- [ ] `config.base.feeBumpPercent` (from ticket 01) controls the minimum bump percentage applied to both fee fields; it has a documented default
- [ ] When Retry Policy is on and a transaction is judged stuck, a new `PreparedTransaction`/`SignedTransaction` is built at the same nonce with both `maxFeePerGas` and `maxPriorityFeePerGas` at least the configured percentage above the original's values
- [ ] The replacement is recorded as a new Transaction row, not a mutation of the original — the original's own record is left intact
- [ ] When Retry Policy is off, a stuck Base transaction is never fee-bumped — it follows ticket 08's `ABANDONED` path instead, unchanged
- [ ] Proven against real Base Sepolia: a deliberately underpriced transaction is submitted, judged stuck, replaced with a correctly bumped one, and the replacement confirms
