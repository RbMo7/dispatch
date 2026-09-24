Status: blocked-by-01,02

# POST /v1/dispatch mode:"relay" route and GET response shape

The `mode: "relay"` branch on the existing `POST /v1/dispatch` handler (`src/api/dispatch-routes.ts`) — routes on `chain` via the `ChainRegistry` exactly like Managed Dispatch already does, then calls the registered Chain Handler's `validateSignedTransaction` (core-engine-scaffold issue 13 — a new, cheap, RPC-free interface method, not built here) before ever persisting anything. A submission that fails this check is rejected with `400` immediately; nothing gets queued, nothing takes up space waiting to fail asynchronously at broadcast. Idempotency-Key handling mirrors Managed Dispatch's own (ADR-0021): resubmitting the same key returns the original `RelayDispatch`'s current state, never creates a second one.

`GET /v1/dispatch/:id` grows the ability to resolve a `RelayDispatch` id too, returning issue 01's distinct response shape (`{dispatchId, mode: "relay", status, transactionHash, error}`) rather than forcing Managed Dispatch's `items`-array shape onto something that was never a batch.

Blocked on core-engine-scaffold issue 13 landing first (this route's whole reason for existing is to call the new validation method it adds) — implement this once that interface change is in, not before.
