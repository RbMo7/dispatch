Status: ready-for-agent

# 11: Bulk Call

**What to build:** The opt-in-per-request Bulk Call batching mode (ADR-0006): an integrator supplies a caller-owned aggregator contract address plus the Payments/Calls to bundle, and `BaseChainHandler` encodes them as one `aggregate3Value(Call3Value[])` transaction against Multicall3's known interface (`0xcA11bde05977b3631167028862bE2a173976CA11`). Each item gets `allowFailure: true` so one bad payment doesn't take down its batch-mates. A batch larger than the configured max size splits across multiple Bulk Call transactions.

**Blocked by:** 04 (ERC-20 token transfer), 05 (smart contract call submission).

**Status:** ready-for-agent

- [ ] A Bulk Call request bundles a mix of native, ERC-20, and raw-Call items into one `aggregate3Value` transaction
- [ ] Every bundled item has `allowFailure: true`; the per-item outcome is read from the transaction's `Result[]` return data, not just the top-level receipt status
- [ ] One deliberately failing item inside a bundle reports `FAILED` for that item alone while its batch-mates confirm normally
- [ ] `config.base.bulkCallMaxBatchSize` (from ticket 01) caps items per transaction; a request exceeding it is automatically split into multiple Bulk Call transactions rather than rejected or silently truncated
- [ ] The default one-tx-per-payment mode (unaffected by this ticket) still works exactly as before when Bulk Call isn't opted into
- [ ] Proven against real Base Sepolia against a real Multicall3-shaped aggregator: a bundle with one intentionally-failing item and several succeeding items produces the expected mixed per-item outcome
