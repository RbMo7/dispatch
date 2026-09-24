Status: resolved

# PostgresDispatchStore has never been exercised against real Postgres

Found while wiring the worker loop (issue 12, 2026-09-24): `PostgresDispatchStore` has no test file of its own (`src/repository/` only has `in-memory-dispatch-store.test.ts`), and every existing test — including every Coordinator and API-route test — runs against `InMemoryDispatchStore` instead. Nothing in the automated suite had ever inserted a row through the real Postgres schema before this session's manual, one-off end-to-end run (separate `index.ts`/`worker.ts` processes, a real local Postgres, real devnet).

That manual run immediately surfaced a real bug `InMemoryDispatchStore` could never have caught: `transactions.dispatch_id` had a foreign key constraint pointing only at `dispatches.id`, but a Relay Dispatch's `Transaction.dispatchId` legitimately points at `relay_dispatches.id` instead (ADR-0031) — every single Relay Dispatch broadcast, success or failure, failed at the final `INSERT` with a foreign-key violation. Fixed in the same pass (migration `0004_high_zzzax.sql` drops the constraint — `dispatchId` is documented in `schema.ts` as deliberately not a FK, since it can't express "one of two tables").

The bug is fixed, but the gap that let it hide is still open: `PostgresDispatchStore` — the store every real deployment actually uses — has zero automated coverage of its own schema, constraints, or Drizzle query correctness. ADR-0013's two-tier testing discipline (fast pure-unit + real devnet RPC) never addresses persistence at all; `InMemoryDispatchStore` standing in everywhere means a real SQL-level bug (a bad constraint, a wrong column type, a broken migration) has no automated way to surface before a live deployment hits it.

Needs a design decision before implementation:

- Does this warrant a third tier (real local Postgres, matching devnet's "real infrastructure, no fakes" spirit) or a lighter-weight schema-only check (e.g. asserting the Drizzle schema has no FK pointing at a column that's actually polymorphic)?
- If a real-Postgres tier: how does CI/local dev provision one — a fixed local instance (as this session used), docker-compose, or something else — and does that conflict with or extend ADR-0013's existing two-tier framing?
- Minimum bar: at least one test proving both `Transaction.dispatchId` origins (a Managed Dispatch's `dispatches.id` and a Relay Dispatch's `relay_dispatches.id`) round-trip through `PostgresDispatchStore.createTransaction`/`recordCallFailure` without a constraint violation — the exact class of bug this ticket exists because of.

## Comments

Resolved 2026-09-24: added a real-Postgres third tier, recorded as ADR-0034 (extends ADR-0013). No new provisioning was needed — `docker-compose.yml`'s existing `postgres` service already matches `config.databaseUrl`'s default and was already reachable/migrated in this session's environment. No CI exists yet in this repo, so CI provisioning is deferred until CI itself exists, mirroring how `solana-chain-handler`'s devnet tests already assume reachable infrastructure with no CI wired up either.

- New `src/repository/postgres-dispatch-store.test.ts`: runs unconditionally (no skip/gate) against the real local Postgres, truncating its own tables between tests for isolation. Covers `createDispatch`/`createRelayDispatch` idempotency against the real unique indexes, `claimQueued`'s real `for('update', skipLocked: true)` locking transaction, `recordBroadcast`'s real `attempts` FK insert (plus its hash-mismatch rejection), status transitions, and — the minimum bar above — both `Transaction.dispatchId` origins round-tripping through both `createTransaction` and `recordCallFailure`.
- Verified the new tests actually catch the original bug class: temporarily re-added the bad `transactions.dispatch_id -> dispatches.id` FK by hand, confirmed both Relay-Dispatch-origin tests fail with the exact `insert or update ... violates foreign key constraint` error the manual run hit, then dropped it again and confirmed all 10 tests pass.
- Full non-devnet suite (rpc-timeout, signer client, coordinator, in-memory store, postgres store) passes: 79/79.
