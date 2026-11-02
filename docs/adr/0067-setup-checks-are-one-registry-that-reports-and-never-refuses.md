# Setup checks are one registry, run in three places, that report and never refuse

Accepted 2026-11-01. Builds on ADR-0059. Spec: `.scratch/setup-tooling/spec.md`.

The startup checks (ADR-0049, ADR-0051, ADR-0055) stop at the first problem and print it to a log. An operator learns about a missing key, an unpinned key or a low fee balance one restart or one failed Dispatch at a time, and the console never sees any of it.

## Decision

- **One registry of typed checks**, `src/setup/checks.ts`. Each check has an id, an area and the places it may run, and returns pass, warn or fail with a finding and, unless it passed, a fix: a command, a setting, or a step. A check about a Sender runs once for each Sender (ADR-0060).
- **Three places run it:**
  - `cli`: `pnpm dispatch doctor` and `pnpm dispatch init`. `doctor` exits 1 on any failure, so a deploy can gate on it.
  - `worker`: at start and every five minutes, recording the latest result per check.
  - `api`: on each `GET /v1/setup`, only the checks that need no Signer and no chain (database, migrations, console build), plus the checks about settings only the API process is given: `AUTH_TOKEN` and `OPERATOR_TOKEN` (the Tokens check).
- **A check runs only where its inputs exist.** The worker is never given the API's tokens, so running the Tokens check there reported "OPERATOR_TOKEN is not set" on every engine; it moved to the API (2026-11-02).
- **The console reads what the worker recorded**, merged with the API's own results, each marked with where and when it ran. It never calls the Signer (ADR-0059).
- **Checks reuse the engine's code paths** (configuration parsing, the handlers' reads, the Signer pin read, the multisig startup checks), never a copy of them.
- **A check reports; it never stops a process.** The engine still refuses to start only in the unsafe states it already refused (ADR-0049, ADR-0051, ADR-0055).

## Considered options

- **The API runs every check on request.** Rejected: it needs the Signer's URL and token in the API (ADR-0059), and an RPC read per page view.
- **Separate checks for `doctor` and the console.** Rejected: they would drift, and the two would disagree about the same engine.
- **Refuse to start on a failing check.** Rejected: an RPC blip or a low fee balance would take the engine down. Refusals stay for unsafe states.

## Consequences

- The Setup page can be up to five minutes behind; it shows when each check last ran.
- One more table, written only by the worker, like the Signer pin record of ADR-0059.
