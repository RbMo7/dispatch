Status: spec-drafted-issues-pending (ADR-0026)

# Relay Dispatch

## Problem Statement

An application whose own end users bring their own wallets (a DEX, say) needs the engine to reliably deliver and track a transaction it never built and can't fee-bump — someone else already signed it. Managed Dispatch's whole machinery (Signer, nonce ownership, Retry Policy) doesn't apply here; ADR-0005 already settled the shape, this spec just plans it out.

## Solution

A second dispatch mode, `POST /v1/dispatch` with `"mode": "relay"` (exact field TBD when issues are written — see `docs/api.md`'s "not yet specced" list) carrying an already-signed transaction instead of `Call`/`Payment` items. The engine: broadcasts it, retries delivery of the *same signed bytes* on transient failure (never a fee-bump — it has no key), and tracks confirmation exactly like Managed Dispatch's status/webhook story (ADR-0023). A stuck Relay Dispatch transaction is reported plainly — "stuck, cannot auto-resolve, the original signer must resubmit" — never implying the same reliability guarantee Managed Dispatch gives.

Reuses the Chain Handler's broadcast/status logic (it's the same underlying `sendTransaction`/`getSignatureStatus` calls Managed Dispatch already needs) — a Relay Dispatch should not need its own parallel broadcast implementation per chain.

## Out of Scope (for the first cut)

- Fee-bumping or any retry that changes the signed bytes — structurally impossible without the original key (ADR-0005).
- Multi-signature/M-of-N collection (a DAO treasury scenario raised earlier) — a real, separate extension, not part of this.
- Idempotency for Relay Dispatch specifically hasn't been decided yet — a signed transaction's own hash may already be a natural dedup key (resubmitting identical bytes is the same Transaction, per CONTEXT.md's Attempt/Transaction distinction) — confirm this holds before assuming ADR-0021's Idempotency-Key header applies unchanged here.

## Further Notes

No issues yet, per ADR-0026 — written once Solana's broadcast (issue 05), blockhash-retry (issue 06), and status-tracking (issue 07) have landed for Managed Dispatch, since Relay Dispatch is meant to reuse that same Chain Handler machinery rather than duplicate it.
