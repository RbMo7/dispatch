Status: ready-for-agent

# 01: Relay Dispatch end to end (Solana)

**What to build:** A caller can sign a Solana transaction entirely outside the engine — their own wallet, their own key, the engine never sees it — submit it via `POST /v1/dispatch` with `mode: "relay"`, and later poll `GET /v1/dispatch/:id` to see it confirmed. Confirmation is independently verified against real devnet state, not just the engine's own bookkeeping. A malformed or garbage submission is rejected with `400` immediately and never persisted. Resubmitting the same `Idempotency-Key` returns the original result rather than creating a duplicate.

**Blocked by:** solana-chain-handler issue 14 (`SolanaChainHandler.validateSignedTransaction`) — this route's whole reason for calling into the Chain Handler at submission time is to use that method.

**Status:** ready-for-agent

- [ ] `POST /v1/dispatch` accepts an optional `mode` field (`"managed" | "relay"`), defaulting to `"managed"` — every existing Managed Dispatch request keeps working unchanged
- [ ] A `mode: "relay"` request body is `{ chain, signedTransaction }` — no `items`, no `retryPolicy`
- [ ] A new `RelayDispatch` domain type (`{id, chain, idempotencyKey, signedTransaction, status, transactionId}`) — never a `Dispatch`/`DispatchItem` variant
- [ ] Repository methods for `RelayDispatch` (create, get, claim-queued) exist on both the in-memory fake and the real Postgres store
- [ ] The route calls `validateSignedTransaction` before ever persisting a `RelayDispatch`; a failure returns `400` and nothing is queued
- [ ] `Idempotency-Key` is required; resubmitting the same key returns the original `RelayDispatch`'s current state, never creates a second one
- [ ] The Coordinator claims a queued `RelayDispatch` and broadcasts it exactly once (no `validateCall`/`prepare`/`sign` step — nothing to build, it already arrived signed)
- [ ] Confirmation tracking reuses `Coordinator.pollPendingTransactions` completely unchanged — no Relay-Dispatch-specific branch inside it
- [ ] `GET /v1/dispatch/:id` for a Relay Dispatch returns `{dispatchId, mode: "relay", status, transactionHash, error}` — an honestly distinct shape, not a fake one-item version of Managed Dispatch's `items` array
- [ ] Proven against real devnet (ADR-0013): a transaction signed by a keypair entirely outside the engine is submitted through the real API, reaches a terminal state, and its effect (recipient balance, or on-chain logs for a non-transfer call) is independently checked against the chain itself
