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
- Done since: `solana-landing` (#32–#34, #36–#38; PR #35, merged 2026-09-27) — Solana expiry resubmitted by the Coordinator and written down first (ADR-0042), identical-bytes resends while waiting, blockhash records restored at restart, an opt-in priority fee with a simulated compute-unit limit, size-aware bundling, v0 Relay Dispatch, a websocket-free test-mint fixture; `solana-hardening` (#39–#43; PR #45, merged) — the Funding Check counts SOL for fees and token-account rent (ADR-0043), Token-2022, concurrent sends (ADR-0044), an automatic priority fee, plus a mainnet-readiness review: expiry proven by block height with a lag margin (ADR-0045), RPC 5xx/node-behind treated as ambiguous, `call` items validated at the API, durable-nonce Relay transactions never treated as expiring, resubmissions pooled, configured tokens verified at startup. `demo/base/` holds three Base Sepolia end-to-end demos.
- Testing: `pnpm test:offline` (unit + fake-store Coordinator + real-Postgres tiers, ADR-0034) is what CI runs (`.github/workflows/ci.yml`). The live-chain tier — every test importing `test-support/*-fixtures` — runs only locally via `pnpm test`, since it spends testnet funds (ADR-0013); the Base and Solana volume runs additionally need `RUN_BASE_VOLUME=1` / `RUN_SOLANA_VOLUME=1` (ADR-0040). Live RPC URLs come from a gitignored `.env` (loaded by the test runner and by `src/config.ts`).
- Done since: `production-signer` (`.scratch/production-signer/spec.md`, ADR-0046; issues #47, #48, #55, #50, #49, #51, #52) — the Signer (`signer/`) gets the whole transaction instead of a hash, bearer auth (`SIGNER_AUTH_TOKEN` on both sides), per-address policy, an audit log on stdout, and `privy` and `aws-kms` backends (both curves) chosen per address; `keyfile` is dev only. The engine verifies every signature and maps policy refusals to `SIGNER_REFUSED`. The Compose keyfile-by-name bug is fixed. `docs/signer.md` is the operator runbook and mainnet checklist.
- Follow-ups from it: #57 (worker bug: a `PENDING` transaction on a chain no longer in `ENABLED_CHAINS` halts confirmation polling for every chain; needs triage) and #61 (run `RUN_AWS_KMS=1` against a real KMS key; needs operator-provided AWS keys, so the KMS backend is proven only against mocks until then).
- **Next:** a small mainnet smoke test, following `docs/signer.md`'s checklist, then a separate Base mainnet review.
- Ticketed, waiting on a design decision: #44, Solana Durable Nonce Execution (no expiry, so ADR-0042's safe resubmission would first have to cancel the original).
- Open follow-ups, not yet ticketed: the Bulk Call `allowFailure: true` API-level proof needs a tracing RPC (`BASE_TRACE_RPC_URL`); ADR roadmap items — webhooks (ADR-0023), Ethereum L1 as its own chain (ADR-0035), Sender Pool (ADR-0016).
- Nothing is blocked except #44, on its design decision, and #61, on operator AWS keys. #57 needs triage.
