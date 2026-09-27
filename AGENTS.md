## Before doing anything else

Read `CONTEXT.md` and `docs/adr/` at the repo root — every naming/architecture decision made so far is recorded there, not in chat history. Don't re-derive or re-litigate a decision that's already an ADR; if you think one is wrong, say so and propose a new ADR rather than silently deviating.

## Agent skills

### Issue tracker

Specs stay local, tickets live on GitHub. Each feature is `.scratch/<feature-slug>/spec.md` (the feature-level design record — problem, solution, user stories, decisions); its execution tickets are **GitHub Issues** on `RbMo7/dispatch`, the source of truth for ticket state. See `docs/agents/issue-tracker.md`. (The older `.scratch/*/issues/NN-*.md` files are stale snapshots — don't read ticket state from them.)

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
- Done: `core-engine-scaffold` (issues `01`–`15`), `solana-chain-handler` (`01`–`15`, the first real chain), `relay-dispatch` (a working vertical slice), and `base-chain-handler` — the second real chain, all its GitHub issues (#1–#15) plus #20/#21/#24 filed during review, merged to `main` 2026-09-26 and proven end to end against real Base Sepolia (fee-bump ADR-0037, Bulk Call ADR-0038, nonce gaps ADR-0039, the opt-in volume run ADR-0040, write-before-send ADR-0041).
- Testing: `pnpm test:offline` (unit + fake-store Coordinator + real-Postgres tiers, ADR-0034) is what CI runs (`.github/workflows/ci.yml`). The live-chain tier — every test importing `test-support/*-fixtures` — runs only locally via `pnpm test`, since it spends testnet funds (ADR-0013); the Base volume run additionally needs `RUN_BASE_VOLUME=1` (ADR-0040). Live RPC URLs come from a gitignored `.env` (loaded by the test runner and by `src/config.ts`).
- In progress: `solana-landing` (#32–#34, #36–#38, ADR-0042; PR #35) — Solana expiry resubmitted by the Coordinator and written down first, identical-bytes resends while waiting, blockhash records restored at restart, an opt-in priority fee with a simulated compute-unit limit, size-aware bundling, v0 Relay Dispatch, websocket-free test-mint fixture. Also `solana-hardening` (#39–#43, ADR-0043/0044) on the same PR: the Funding Check counts SOL for fees and new token-account rent, Token-2022 payouts, concurrent sends, an automatic priority fee. #44 (Durable Nonce Execution) is filed and waits on a design decision.
- Open follow-ups, not yet ticketed: the Bulk Call `allowFailure: true` API-level proof needs a tracing RPC (`BASE_TRACE_RPC_URL`); ADR roadmap items — webhooks (ADR-0023), Ethereum L1 as its own chain (ADR-0035), Sender Pool (ADR-0016).
- Nothing is blocked. No open tickets currently need triage.
