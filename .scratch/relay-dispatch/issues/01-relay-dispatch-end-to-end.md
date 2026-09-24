Status: ready-for-agent

# RelayDispatch domain type and wire format

A new, deliberately small domain type — `RelayDispatch { id, chain, idempotencyKey, signedTransaction, status, transactionId }` — not a variant of `Dispatch`/`DispatchItem`: a Relay Dispatch is always exactly one already-signed transaction (never a batch), and forcing it into `Dispatch.items[]` would mean every reader of that array handles a permanently-meaningless placeholder. `signedTransaction` is the same opaque `SignedTransaction` string type `ChainHandler.broadcast` already takes — the engine never decodes it itself (ADR-0027's opacity discipline extends here unchanged). Once broadcast, `transactionId` points at an ordinary `Transaction` row (`src/domain/transaction.ts`) — Relay Dispatch reuses that type completely unchanged, never inventing its own.

Wire format (`POST /v1/dispatch`, same endpoint as Managed Dispatch — one integration surface, not two):
- A new optional `mode` field, `"managed" | "relay"`, defaulting to `"managed"` when omitted so every existing caller keeps working unchanged.
- `mode: "relay"` request body carries `{ chain, signedTransaction }` — no `items`, no `retryPolicy` (Retry Policy doesn't apply: ADR-0005, no key to fee-bump with), no Funding Check (nothing here is the engine's own money).
- `Idempotency-Key` header still required, same as Managed Dispatch (ADR-0021) — protects against a caller resubmitting a genuinely different signed transaction under retry logic, which a transaction-hash-based dedup key alone wouldn't catch.
- `GET /v1/dispatch/:id` for a Relay Dispatch returns an honestly distinct shape, not a fake one-item version of Managed Dispatch's `items` array: `{ dispatchId, mode: "relay", status, transactionHash, error }`. Include `mode` in every response (both shapes) so a caller can tell which they're looking at from the body alone.

Update `docs/api.md`'s "Not yet specced" list — Relay Dispatch's wire shape is exactly what this issue defines.
