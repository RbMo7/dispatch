# The real-Postgres tier runs in its own throwaway database

ADR-0034 ran the real-Postgres tests against the database `DATABASE_URL` names and truncated its tables between tests. That database is also the one a developer's API and worker use. Each run wiped whatever the developer had queued, and the last test's rows stayed behind. One of them, a PENDING Solana Transaction, later stopped a worker running with `ENABLED_CHAINS=base` from confirming anything (#57).

## Decision

- A Vitest global setup creates a fresh database named `dispatch_test_<pid>_<random>` on the same server, applies the migrations to it, and drops it when the run ends.
- Every test file gets that database's URL as `DATABASE_URL` before it imports anything, so the Postgres tests can still truncate between tests without touching anyone's data.
- This replaces ADR-0034's provisioning consequence only. The tier itself, against real Postgres with no fake, is unchanged.

## Consequences

- The role in `DATABASE_URL` needs `CREATEDB`. The Compose and CI Postgres users are superusers, so both already have it.
- A run killed before teardown leaves a `dispatch_test_*` database behind. Drop it by name. It never holds anything but test rows.
