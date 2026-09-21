Status: blocked-by-05

# Status and confirmation tracking

Implement `getStatus` against Solana's own commitment levels (`processed`/`confirmed`/`finalized`) via `getSignatureStatus`. This issue is purely "what does the chain currently say about this transaction" — it does not decide what the engine should *do* about a transaction that never confirms (that's issue 08). Keeping status-reading and abandonment-deciding separate means each can be tested on its own: this issue against real devnet confirmations at each commitment level, issue 08 against the timeout/decision logic in isolation.
