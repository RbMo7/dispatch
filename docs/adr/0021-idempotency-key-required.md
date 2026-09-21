# A client-supplied Idempotency Key is required on every Dispatch

A client retrying `POST /v1/dispatch` after a timeout, not knowing whether the first attempt landed, is exactly the double-dispatch hazard the project's own edge-case research named as one of its hardest problems. A required `Idempotency-Key` header makes creating a Dispatch a create-once operation: resubmitting the same key returns the original Dispatch rather than creating a second one. Scoped globally, not per-tenant — there is no tenant dimension in this project (ADR-0022's single-API-key model).

## Consequences

Per-`Call` client reference IDs (Fireblocks'/Circle's finer-grained pattern, for deduplicating within a batch) are not built now — only add that if a real need for partial-batch dedup shows up.
