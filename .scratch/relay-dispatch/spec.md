Status: ready-for-agent

# Relay Dispatch

## Problem Statement

An application whose own end users bring their own wallets (a DEX, say) needs the engine to reliably deliver and track a transaction it never built and can't fee-bump — someone else already signed it. Managed Dispatch's whole machinery (Signer, nonce ownership, Retry Policy) doesn't apply here; ADR-0005 already settled the shape, this spec plans it out.

## Solution

A second dispatch mode on the same `POST /v1/dispatch` endpoint — one integration surface, not two. A new optional `mode` field, `"managed" | "relay"`, defaults to `"managed"` when omitted so every existing caller keeps working unchanged. `mode: "relay"` carries `{ chain, signedTransaction }` instead of `Call`/`Payment` items — no `retryPolicy` (no key to fee-bump with), no Funding Check (nothing here is the engine's own money).

The engine: validates the signed transaction's shape cheaply before ever queuing it (`ChainHandler.validateSignedTransaction`, core-engine-scaffold issue 13 — rejects an obviously-malformed submission with `400` immediately, nothing persisted to fail later), then broadcasts it, retries delivery of the *same signed bytes* on transient failure (never a fee-bump — it has no key; this is a new Attempt of the same Transaction, per CONTEXT.md's Attempt-vs-Transaction distinction, using the already-existing-but-unused `DispatchStore.recordBroadcast`), and tracks confirmation via the exact same `Coordinator.pollPendingTransactions` Managed Dispatch already uses, unmodified. A transaction whose blockhash provably expires (Solana, via the same mechanism ADR-0030 already established) resolves to a clean `FAILED`; a chain without that proof falls back to the existing generic `ABANDONED`-after-timeout path. No new terminal status either way — both already exist for exactly this reason.

Reuses the Chain Handler's `broadcast`/`getStatus` completely unchanged (ADR-0027's opacity discipline: the engine never decodes `signedTransaction` itself) — a Relay Dispatch needs no chain-specific orchestration code of its own. This is deliberately multi-chain from day one even though only Solana is implemented first (EVM later): adding a chain means building its own `ChainHandler`, exactly as `solana-chain-handler` was built, never touching Relay Dispatch's own orchestration logic.

`GET /v1/dispatch/:id` for a Relay Dispatch returns an honestly distinct shape — `{ dispatchId, mode: "relay", status, transactionHash, error }` — not a fake one-item version of Managed Dispatch's `items` array. `Idempotency-Key` is still required (ADR-0021), for consistency with Managed Dispatch and because it protects against a caller resubmitting a genuinely *different* signed transaction under retry logic, which a transaction-hash-based dedup key alone wouldn't catch.

Domain representation is a new, deliberately small type — `RelayDispatch { id, chain, idempotencyKey, signedTransaction, status, transactionId }` — never forced into `Dispatch`/`DispatchItem`, since a Relay Dispatch is always exactly one transaction, never a batch to aggregate. Once broadcast, it points at an ordinary `Transaction` row, reused completely unchanged.

A stuck Relay Dispatch transaction is reported plainly via that same terminal-status machinery — never implying the same reliability guarantee Managed Dispatch gives, since the engine structurally cannot fee-bump or resubmit with different bytes here.

## Out of Scope (for the first cut)

- Fee-bumping or any retry that changes the signed bytes — structurally impossible without the original key (ADR-0005).
- Multi-signature/M-of-N collection (a DAO treasury scenario raised earlier) — a real, separate extension, not part of this.
- Pre-queue validation beyond cheap shape/signature checks (`validateSignedTransaction`) — no simulation, no semantic understanding of what the transaction does. A transaction that's structurally valid but will fail on-chain for its own reasons still gets broadcast and fails there, same as Managed Dispatch's own Calls.

## Further Notes

Issues are written (`.scratch/relay-dispatch/issues/`, plus one cross-cutting `ChainHandler` interface change at `core-engine-scaffold` issue 13 and Solana's own implementation of it at `solana-chain-handler` issues 14–16) — the ADR-0026 precondition (Solana's broadcast/blockhash-retry/status-tracking landed for Managed Dispatch) is met.
