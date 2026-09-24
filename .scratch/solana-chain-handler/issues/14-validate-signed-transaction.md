Status: blocked-by-core-scaffold-13

# 14: Solana implements real signed-transaction validation

**What to build:** `SolanaChainHandler` can tell, without touching the network, whether a signed Solana transaction is genuinely valid — a real cryptographic signature, a real fee payer — or garbage/tampered. Demoable directly: hand it a real signed transaction and a tampered one, get the right answer for each, no RPC involved.

**Blocked by:** core-engine-scaffold issue 13 (`ChainHandler.validateSignedTransaction`)

**Status:** blocked-by-core-scaffold-13

- [ ] Decodes the opaque signed-transaction string (same decode `resignWithFreshBlockhash` already does) and confirms at least one signature is present
- [ ] Confirms the signature cryptographically verifies (`verifySignatures()` — a pure local check, no RPC)
- [ ] Confirms a fee payer is set
- [ ] Rejects with a structured `DispatchError`, never throws
- [ ] Tested against both a validly-signed real transaction and a tampered/garbage one — no real devnet needed, this is a pure local decode/crypto check (ADR-0013 governs on-chain *behavior*, not this)
