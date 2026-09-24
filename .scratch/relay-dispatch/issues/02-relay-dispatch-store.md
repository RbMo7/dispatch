Status: blocked-by-01

# RelayDispatch repository methods

Extend the repository (`src/repository/dispatch-store.ts` and both implementations, `InMemoryDispatchStore` and `PostgresDispatchStore`) with `RelayDispatch`'s own persistence: create one (`queued`, no `transactionId` yet), fetch one by id, claim a batch of queued ones for the worker to process, and attach a `transactionId` once broadcast succeeds. Mirrors `Dispatch`'s own `createDispatch`/`getDispatch`/`claimQueued` shape exactly, but against the new, separate type from issue 01 — never reuses the `dispatches` table, since a `RelayDispatch` row has no `items` and no `retryPolicy` to store.

A real Postgres migration is needed for the new table (`drizzle-kit generate`, following `src/db/schema.ts`'s existing conventions) alongside the in-memory fake, per this project's two-tier testing discipline (ADR-0013) — fast unit tests for orchestration run against the fake, the real Postgres implementation is exercised the way `postgres-dispatch-store.ts`'s own commits were (manually verified against a real database, no committed automated test — matching this repo's existing practice, since no CI runs one).
