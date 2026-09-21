Status: blocked-by-07

# ABANDONED timeout decision

Decide and implement when a non-confirming Solana transaction stops being retried. Blockhash expiry is a *provable* dead end here (unlike EVM) — this issue must settle the open question flagged when the spec was written: does Solana even need the `ABANDONED` status (ADR-0004), or does its provable expiry mean a clean, definitive `FAILED` is honestly available once the blockhash is confirmed expired and no confirmation was seen? Pin the chain-aware default timeout value for whichever answer this lands on (ADR-0004's timeout is deliberately chain-aware, not a global constant).

This is a decision issue as much as an implementation one — resolve it explicitly, don't let it default silently to whichever status was easiest to wire up.
