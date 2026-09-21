Status: ready-for-agent

# Repository module (DispatchStore)

Build the repository module ADR-0011 calls for: a small, domain-shaped interface — e.g. `claimQueued()`, `recordBroadcast(transactionId, hash)`, `markAbandoned(transactionId)`, `markFailed(transactionId, error)`, `markConfirmed(transactionId)` — backed by a real Drizzle/Postgres implementation, plus an in-memory fake implementing the same interface for unit tests. The Postgres schema (the outbox table(s) from ADR-0009) lives here.

The Coordinator (issue 06) must be able to run its own unit tests entirely against the fake, never touching a real database.
