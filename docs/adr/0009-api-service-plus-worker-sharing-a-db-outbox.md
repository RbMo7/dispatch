# Architecture: an API service and a separate polling worker, sharing a Postgres outbox table

Researched against Stellar's Disbursement Platform Backend (github.com/stellar/stellar-disbursement-platform-backend) as prior art: its Core (API) and Transaction Submission Service (a separate worker) integrate purely by sharing a `submitter_transactions` table — the API writes rows, the worker polls and drives them to a terminal state, the API reads the same table back. Nothing else about SDP transfers (it's Stellar-only, holds its signing key in-process, and has no chain-abstraction layer — see ADR-0001/0002 for where this project deliberately does the opposite), but this specific pattern — API service + separate polling worker + shared DB outbox + retriable-vs-terminal error bucketing — is adopted as this project's own architecture.

## Consequences

A Chain Handler (CONTEXT.md) is invoked only by the worker side, never by the API request path — the API's job is limited to validating and writing a Dispatch's rows; all chain interaction happens in the worker's poll loop.
