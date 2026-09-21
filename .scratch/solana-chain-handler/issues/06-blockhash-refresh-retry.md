Status: blocked-by-05

# Blockhash-refresh-and-resubmit retry

Handle the case issue 05 deliberately left out: broadcast fails, or the transaction doesn't confirm before its blockhash expires (~150 slots, ~60-90s). Refresh the blockhash and resubmit as a *new* Transaction (CONTEXT.md's Attempt-vs-Transaction distinction — the signed bytes changed, so this is a new Transaction under the same logical Call, not a retried Attempt of the old one). This is the default Solana retry mode (ADR-0007) — no Durable Nonce work here, that's explicitly out of scope for this phase.

Test against real solana-devnet (ADR-0013) — this needs an actual scenario that forces a stale/expiring blockhash, not just a mocked timeout.
