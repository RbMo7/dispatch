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
- **Branches, commits and PRs**: work goes on a branch and a PR into `main`, never straight to `main`. Update the docs in the same PR as the code. Commit messages and PR bodies carry no agent attribution lines (no `Co-Authored-By`, no "Generated with").
- **No agent trails**: nothing committed, pushed or posted names an AI agent or tool as an author: commit messages, PR titles and bodies, issue comments, code comments, docs, and file names. Agent working files (decision trails, plans, scratch notes, review reports, screenshots) stay outside the repo or in an ignored path, never in a commit.

## Where things stand

- `old-docs/` is a frozen snapshot from the prior product this repo diverged from — reference only, never treat it as current.
- `docs/api.md` pins the `/v1/dispatch` wire format.
- Done: `core-engine-scaffold` (issues `01`–`15`), `solana-chain-handler` (`01`–`15`, the first real chain), `relay-dispatch` (a working vertical slice), and `base-chain-handler` — the second real chain, all its GitHub issues (#1–#15) plus #20/#21/#24 filed during review, merged to `main` 2026-09-26 and proven end to end against real Base Sepolia (fee-bump ADR-0037, Bulk Call ADR-0038, nonce gaps ADR-0039, the opt-in volume run ADR-0040, write-before-send ADR-0041).
- Done since: `solana-landing` (#32–#34, #36–#38; PR #35, merged 2026-09-27) — Solana expiry resubmitted by the Coordinator and written down first (ADR-0042), identical-bytes resends while waiting, blockhash records restored at restart, an opt-in priority fee with a simulated compute-unit limit, size-aware bundling, v0 Relay Dispatch, a websocket-free test-mint fixture; `solana-hardening` (#39–#43; PR #45, merged) — the Funding Check counts SOL for fees and token-account rent (ADR-0043), Token-2022, concurrent sends (ADR-0044), an automatic priority fee, plus a mainnet-readiness review: expiry proven by block height with a lag margin (ADR-0045), RPC 5xx/node-behind treated as ambiguous, `call` items validated at the API, durable-nonce Relay transactions never treated as expiring, resubmissions pooled, configured tokens verified at startup. `demo/base/` holds three Base Sepolia end-to-end demos.
- Testing: `pnpm test:offline` (unit + fake-store Coordinator + real-Postgres tiers, ADR-0034) is what CI runs (`.github/workflows/ci.yml`). The live-chain tier — every test importing `test-support/*-fixtures` — runs only locally via `pnpm test`, since it spends testnet funds (ADR-0013); the Base and Solana volume runs additionally need `RUN_BASE_VOLUME=1` / `RUN_SOLANA_VOLUME=1` (ADR-0040). Live RPC URLs come from a gitignored `.env` (loaded by the test runner and by `src/config.ts`). If the default Postgres port is taken on your machine, pass `DATABASE_URL=postgres://dispatch:dispatch@localhost:<port>/dispatch` to `pnpm test:offline`.
- Done since: `production-signer` (`.scratch/production-signer/spec.md`, ADR-0046; issues #47, #48, #55, #50, #49, #51, #52) — the Signer (`signer/`) gets the whole transaction instead of a hash, bearer auth (`SIGNER_AUTH_TOKEN` on both sides), per-address policy, an audit log on stdout, and `privy` and `aws-kms` backends (both curves) chosen per address; `keyfile` is dev only. The engine verifies every signature and maps policy refusals to `SIGNER_REFUSED`. The Compose keyfile-by-name bug is fixed. `docs/signer.md` is the operator runbook and mainnet checklist.
- Done since: `multisig-and-local-signer` and `safe-multisig-base` (specs in `.scratch/`; ADR-0049 to ADR-0054; issues #70–#89; follow-ups #91, #94–#96) — a human in the loop for the Sender, built as one shared approval flow: a **Treasury** (a multisig funds a plain hot Sender) and a **Multisig Sender** (every transfer is proposed by the engine, approved by Approvers in the Squads app on Solana or the Safe app on Base, then executed by the engine), plus a `local` encrypted-keystore Signer backend and an independent **verifier CLI** (`verifier/`) so Approvers can check a proposal against their own payment file. A proposal never mixes Dispatches; an undecided proposal is `ABANDONED` (`APPROVAL_TIMEOUT`), never `FAILED`, and is watched for 30 days (ADR-0053). `docs/multisig.md` is the operator guide. Proven end to end against devnet and Base Sepolia (`RUN_SQUADS=1`, `RUN_SAFE=1`); **nothing has run on mainnet**.
- Follow-ups from it: #57 (worker bug: a `PENDING` transaction on a chain no longer in `ENABLED_CHAINS` halts confirmation polling for every chain; needs triage) and #61 (run `RUN_AWS_KMS=1` against a real KMS key; needs operator-provided AWS keys, so the KMS backend is proven only against mocks until then).
- **Next:** a small mainnet smoke test, following `docs/signer.md`'s checklist (including its multisig items), then a separate Base mainnet review. On hold: there are no mainnet funds yet.
- Deferred: Solana Durable Nonce Execution (ADR-0048, #44 closed): not built until a Sender needs offline signing or volume shows expiry failures; if built, cancel by advancing the nonce before resubmitting.
- Open follow-ups, not yet ticketed: the Bulk Call `allowFailure: true` API-level proof needs a tracing RPC (`BASE_TRACE_RPC_URL`); ADR roadmap items — webhooks (ADR-0023), Ethereum L1 as its own chain (ADR-0035), Sender Pool (ADR-0016).
- Done since: the Signer pin check (#95; ADR-0055; #99–#101) — the Signer reports what a key is pinned to on `GET /keys/{address}/policy`, and the engine refuses to start for a Multisig Sender whose key is unpinned, pinned elsewhere, or on a Signer too old to say. `docs/signer.md` and `docs/multisig.md` cover it. It is proven only offline: the live multisig runs (`RUN_SQUADS=1`, `RUN_SAFE=1`) were adapted to it but not run.
- Open from the multisig work: #91 (Squads batch proposals; needs a human to check the Squads app shows a batch's contents), #96 (human checks before mainnet: Squads app labels and rent collector, Safe plan quotas, delegate removal, self-hosting).
- Next up: `web-console` (`.scratch/web-console/spec.md`, `design.md`; ADR-0056; issues #109–#114, #121–#127): an operator console served by the engine, a public landing page, and a `/docs` site rendered from a rewritten `docs/`. Then `flag-rules` (`.scratch/flag-rules/spec.md`; ADR-0057, ADR-0058; #115–#120, #128): operator-set rules that hold a Dispatch for release or cancel.
- Nothing is blocked except #61, on operator AWS keys, and the human checks in #91 and #96.
