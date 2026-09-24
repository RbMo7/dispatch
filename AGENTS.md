## Before doing anything else

Read `CONTEXT.md` and `docs/adr/` at the repo root — every naming/architecture decision made so far is recorded there, not in chat history. Don't re-derive or re-litigate a decision that's already an ADR; if you think one is wrong, say so and propose a new ADR rather than silently deviating.

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`. Each feature is `spec.md` (the feature-level spec — problem, solution, user stories, decisions) plus `issues/NN-slug.md` (one file per execution ticket, numbered from `01`). A `Status:` line near the top of each file records triage state.

### Triage labels

Default five canonical roles, unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.

## Review cadence

- **`core-engine-scaffold`**: one issue at a time. Implement issue `NN`, stop, and let it be reviewed before starting `NN+1` — this is the foundation everything else plugs into, so mistakes here are the most expensive to leave uncaught.
- **Chain-specific work** (`solana-chain-handler` and every chain after it): work through a whole feature's `spec.md` — all its issues — in one pass, then report back. No per-issue check-in required once the scaffold itself is settled and proven.

## Where things stand

- `old-docs/` is a frozen snapshot from the prior product this repo diverged from — reference only, never treat it as current.
- `docs/api.md` pins the `/v1/dispatch` wire format.
- Current work order: `.scratch/core-engine-scaffold/` (spec done, issues `01`–`15` all implemented — `11`/`14`/`15` were filed during `12`'s review, triaged and resolved 2026-09-24: `11` was a doc-only spec fix, `14` added a real-Postgres third testing tier (ADR-0034), `15` pushed an RPC/Signer timeout into the Chain Handler/Connection boundary rather than the worker loop); `.scratch/solana-chain-handler/` (spec done, issues `01`–`15` all implemented — `13` (wire bundling into the Coordinator's real call loop) triaged and resolved 2026-09-24: same-tick opportunistic, automatic bundling, no caller-selectable mode, per ADR-0006) is the first real chain, proven end to end; `.scratch/relay-dispatch/` (spec done, single ticket `01` — the full end-to-end vertical slice, broken out via `/to-tickets` — implemented) is a working vertical slice, verified against real devnet.
- Nothing is blocked. No open tickets currently need triage.
