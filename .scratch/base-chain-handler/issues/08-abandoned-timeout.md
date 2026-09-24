Status: ready-for-agent

# 08: ABANDONED timeout

**What to build:** A Base transaction that never gets a receipt stops being actively tracked after the Coordinator's existing generic abandonment timeout (ADR-0004) rather than being polled forever, and is reported honestly as `ABANDONED` — distinct from `FAILED` — since a `null` receipt on EVM is never provably permanent the way Solana's blockhash expiry is (no EVM analogue of ADR-0030 is built here; that's explicitly deferred).

**Blocked by:** 06 (status and confirmation tracking).

**Status:** ready-for-agent

- [ ] A Base transaction whose `getStatus` keeps returning `PENDING` past the Coordinator's existing chain-agnostic timeout is marked `ABANDONED`, with zero new Base-specific timeout logic added
- [ ] `ABANDONED` is reported distinctly from `FAILED` in the API response, same vocabulary Solana already uses
- [ ] `Transaction.abandonedAt` is set the same way it already is for Solana's abandoned transactions
- [ ] This ticket does not implement the higher-nonce-confirmed proof (the deferred EVM analogue of ADR-0030) — confirm explicitly that a transaction which could theoretically be proven dead by that mechanism still just times out to `ABANDONED` here, since that logic doesn't exist yet
