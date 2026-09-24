# Relay Dispatch shares Managed Dispatch's endpoint via a `mode` field, but gets its own domain type

ADR-0005 and ADR-0026 already settled Relay Dispatch's shape and deferred its issues; this fills in the two wire/domain decisions its spec left as "TBD when issues are written."

**Wire format**: `POST /v1/dispatch` gains an optional `mode: "managed" | "relay"` field rather than a dedicated `POST /v1/relay` endpoint, and defaults to `"managed"` when omitted so every existing caller keeps working unchanged. An integrator thinks in terms of "dispatch a transaction" — one endpoint to document and version is worth more than the marginal clarity a split would buy, especially since the internal representation is free to diverge completely regardless of what the wire contract looks like.

**Domain type**: `RelayDispatch` is its own type — `{id, chain, idempotencyKey, signedTransaction, status, transactionId}` — never a `Dispatch`/`DispatchItem` variant. `Dispatch.items[]` exists specifically to aggregate *multiple* Calls into one derived batch status; a Relay Dispatch is always exactly one already-signed transaction, with no batch to aggregate. Forcing it into `Dispatch.items[]` would mean an array permanently of length one and a `call`/`payment` pair that are both meaningless for it — every future reader of that array would carry a special case for something that can never actually vary. `GET /v1/dispatch/:id` reflects this honestly: a Relay Dispatch's response shape (`{dispatchId, mode, status, transactionHash, error}`) is distinct from Managed Dispatch's `items`-array shape, not a fake single-item version of it. Every response includes `mode` either way, so a caller can tell which they're looking at from the body alone.

## Consequences

One endpoint, two request/response shapes discriminated by `mode`, and two backing domain types (`Dispatch` and `RelayDispatch`) sharing only the downstream `Transaction`/`Attempt` records once a Relay Dispatch actually broadcasts. `DispatchStore` grows a parallel set of create/get/claim-queued methods for `RelayDispatch`, backed by its own table — never squeezed into the `dispatches` table.
