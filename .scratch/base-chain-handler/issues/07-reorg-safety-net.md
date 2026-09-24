Status: ready-for-agent

# 07: Reorg safety net

**What to build:** Because reporting `CONFIRMED` at ~2s (ticket 06) trades away Base's own documented (near-zero but nonzero) L2 reorg possibility, add a low-frequency background re-check — same shape as the existing `ABANDONED` re-watch mechanism (`core-engine-scaffold` issue 10: bounded window, infrequent polling), but a different trigger: it watches an already-`CONFIRMED` Base transaction, not an `ABANDONED` one, and re-verifies its receipt is still present once its block reaches the OP Stack "safe" head. This must never delay or gate the initial `CONFIRMED` report from ticket 06 — it's a pure background safety net.

**Blocked by:** 06 (status and confirmation tracking).

**Status:** ready-for-agent

- [ ] Once a Base transaction is marked `CONFIRMED`, it's enrolled in a low-frequency background re-check (same polling cadence/shape as issue 10's `ABANDONED` re-watch)
- [ ] The re-check compares the transaction's block number against the current OP Stack "safe" head; if the receipt is still present at or past "safe", the re-check stops (no more work needed for that transaction)
- [ ] If the re-check ever finds the receipt gone (a reorg happened), the transaction is reopened/flagged rather than left silently `CONFIRMED`
- [ ] The initial `CONFIRMED` report from ticket 06 is not delayed, blocked, or gated by this mechanism in any way — verified by timing, not just by code inspection
- [ ] This ticket does not need a real reorg to prove itself (Base reorgs are documented as vanishingly rare) — a synthetic/forced scenario (e.g. a transaction the test itself races against block progression) is acceptable, same spirit as how ticket 09's fee-bump test forces a stuck-transaction scenario rather than waiting for one to occur naturally
