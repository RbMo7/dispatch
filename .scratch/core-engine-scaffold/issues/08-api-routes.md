Status: blocked-by-02,03

# API routes

Implement `POST /v1/dispatch` and `GET /v1/dispatch/:id` against the wire format pinned in `docs/api.md`. `POST /v1/dispatch`: checks the bearer token (ADR-0022) before anything else, checks `Idempotency-Key` against the repository (ADR-0021/issue 03) and returns the existing Dispatch if it's a repeat, otherwise validates and persists a new Dispatch (translating `payment` items into `Call`s per ADR-0018) and returns `202` immediately — this route never talks to a Chain Handler or a Signer; that's the Coordinator's job (issue 06), not the ingest path's.

`GET /v1/dispatch/:id`: reads current state via the repository and returns it in the shape `docs/api.md` specifies, `error` always in ADR-0010's structured shape.
