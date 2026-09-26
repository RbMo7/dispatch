Status: ready-for-agent

# 06: Status and confirmation tracking

**What to build:** `getStatus` wired into the Coordinator's existing polling loop, reporting `CONFIRMED` as soon as a transaction's block is included on Base (~2s) — deliberately the fast stage, not waiting for OP Stack "safe" head, per the grill decision to not trade away Base's speed advantage. `FAILED` for a definitively reverted receipt. `PENDING` for a not-yet-included transaction.

**Blocked by:** 03 (native ETH transfer, end to end).

**Status:** ready-for-agent

- [ ] `getStatus` calls `eth_getTransactionReceipt`; `status: 1` → `CONFIRMED`, `status: 0` → `FAILED`, `null` → `PENDING`
- [ ] `getStatus` never reports `CONFIRMED` for a hash that was never actually broadcast or hasn't actually confirmed on-chain
- [ ] `Coordinator.pollPendingTransactions` tracks a Base transaction to a terminal state with zero Base-specific branching inside it — reused completely unchanged, same as it already is for Solana
- [ ] Proven against real Base Sepolia: a transaction from ticket 03 is polled through the real API from `queued` to `confirmed` in roughly the ~2s window Base's own docs describe
- [ ] Proven against real Base Sepolia: a call that reverts on-chain (ticket 05's revert case) is polled to `failed`, distinct from a transaction that's merely still pending
