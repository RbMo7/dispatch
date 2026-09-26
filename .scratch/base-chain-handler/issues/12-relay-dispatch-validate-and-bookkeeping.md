Status: ready-for-agent

# 12: Relay Dispatch — validate and externally-signed bookkeeping

**What to build:** The Base analogue of `solana-chain-handler`'s issues 14+15, built together this time since there's no already-shipped assumption to retrofit: `validateSignedTransaction` (EIP-1559 type `0x02` decode, signing-hash recompute, sender recovery, chain-ID check, all RPC-free) plus `broadcast`/`getStatus` deriving nonce/chain-ID bookkeeping directly from externally-signed bytes with no RPC round-trip. This makes `POST /v1/dispatch mode: "relay"` work on Base end to end, reusing Relay Dispatch's existing chain-agnostic orchestration (`relay-dispatch/spec.md`) completely unchanged.

**Blocked by:** 06 (status and confirmation tracking).

**Status:** ready-for-agent

- [ ] `validateSignedTransaction` accepts a well-formed EIP-1559 type `0x02` signed transaction and rejects legacy/type `0x01` transactions with a structured `DispatchError`
- [ ] `validateSignedTransaction` recomputes the signing hash, recovers the sender address, and rejects malformed signatures — no RPC round-trip anywhere in this check
- [ ] `validateSignedTransaction` rejects a signed transaction whose embedded chain ID doesn't match this handler's configured network
- [ ] `broadcast` of an externally-signed transaction (one this handler never itself signed) decodes its nonce and chain ID directly from the bytes and records them into ticket 02's nonce-history the same way a self-signed broadcast does — no RPC needed to read what's already public in the bytes
- [ ] `getStatus` for a Relay Dispatch transaction behaves identically to a Managed Dispatch one — same `CONFIRMED`/`FAILED`/`PENDING`/`ABANDONED` mapping, same reorg safety net from ticket 07
- [ ] Proven end to end against real Base Sepolia: a transaction signed entirely outside the engine is submitted via `POST /v1/dispatch mode: "relay"`, reaches a terminal state, and its effect is independently verified on-chain
- [ ] A malformed or wrong-chain-ID signed transaction is rejected with `400` immediately and never persisted as a queued `RelayDispatch`
