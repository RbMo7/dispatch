# Requests refused at submission are recorded

Accepted 2026-11-01.

A `POST /v1/dispatch` that the engine refuses (an unknown asset, a malformed call, a multisig Sender asked for a call it cannot propose) is never stored, so an operator cannot see that a client is failing. Operators asked for every error to show in the console where it happened. Spec: `.scratch/flow-coverage/spec.md`.

## Decision

- Every refused `POST /v1/dispatch` with a 4xx status other than 401 is recorded: time, chain, Idempotency-Key, token kind, error code and message, and the request body.
- Records are kept 30 days and capped at 10,000 rows, oldest dropped first.
- `GET /v1/rejected` (operator token) lists them; the console shows them with a plain explanation and a fix link.
- 401s are not recorded, so an unauthenticated caller cannot fill the table.

## Considered options

- **Leave it to the client's own logs.** Rejected: the operator and the client author are often different people, and the operator is the one who can fix a missing asset.
- **Store only the error, not the body.** Rejected: the body is what shows which recipient, asset or item was wrong; it holds no secrets (the token is a header).

## Consequences

- Request bodies (addresses, amounts) are kept for 30 days; operators who must not keep them can lower the retention setting.
