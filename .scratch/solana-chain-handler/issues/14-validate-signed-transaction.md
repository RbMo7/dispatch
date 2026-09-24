Status: blocked-by-core-scaffold-13

# Implement SolanaChainHandler.validateSignedTransaction

Decode the opaque signed-transaction string (`Transaction.from(raw)`, the same decode `resignWithFreshBlockhash` already does) and check it actually is one: at least one signature present, `verifySignatures()` passes (a pure local cryptographic check — no RPC, matching the interface's own "never round-trips" rule), and a fee payer is set. Rejects with a structured error, never a thrown exception, exactly like every other validation path in this handler.

Real devnet isn't needed to test this (ADR-0013's real-RPC discipline governs chain *behavior*, not local decode/crypto checks) — a well-formed signature over garbage instructions still verifies locally and should still pass here; only `broadcast` can ever tell you the chain itself rejected it.
