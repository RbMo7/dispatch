## Before doing anything else

Read `CONTEXT.md` and `docs/adr/` at the repo root — every naming/architecture decision made so far is recorded there, not in chat history. Don't re-derive or re-litigate a decision that's already an ADR; if you think one is wrong, say so and propose a new ADR rather than silently deviating.

## Agent skills

### Issue tracker

Specs stay local, tickets live on GitHub. Each feature is `.scratch/<feature-slug>/spec.md` (the feature-level design record — problem, solution, user stories, decisions); its execution tickets are **GitHub Issues** on `RbMo7/dispatch`, the source of truth for ticket state. See `docs/agents/issue-tracker.md`. (The older `.scratch/*/issues/NN-*.md` files are stale snapshots — don't read ticket state from them.)

### Issue status labels

Every open issue carries exactly one status label in plain words: `needs-triage`, `ready-to-go`, `blocked`, `in-progress`, `in-review`, `waiting`, `wont-do`. Swap it whenever the issue's state changes. Never use `ready-for-agent` or `ready-for-human`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.

## Review cadence

- **`core-engine-scaffold`**: one issue at a time. Implement issue `NN`, stop, and let it be reviewed before starting `NN+1` — this is the foundation everything else plugs into, so mistakes here are the most expensive to leave uncaught.
- **Chain-specific work** (`solana-chain-handler` and every chain after it): work through a whole feature's `spec.md` — all its issues — in one pass, then report back. No per-issue check-in required once the scaffold itself is settled and proven.
- **Branches, commits and PRs**: work goes on a branch and a PR into `main`, never straight to `main`. Update the docs in the same PR as the code. Commit messages and PR bodies carry no agent attribution lines (no `Co-Authored-By`, no "Generated with").
- **No agent trails**: nothing committed, pushed or posted names an AI agent or tool as an author: commit messages, PR titles and bodies, issue comments, code comments, docs, and file names. Agent working files (decision trails, plans, scratch notes, review reports, screenshots) stay outside the repo or in an ignored path, never in a commit.

## Where things stand

As of 2026-11-02.

- `old-docs/` is a frozen snapshot from the prior product this repo diverged from. Reference only, never current.
- **Wire format and docs.** `docs/openapi.yaml` pins the `/v1` wire format, and `src/api/openapi.contract.test.ts` drives the real routes through its examples, so a route that drifts from it, or a `/v1` route it lacks, fails CI (ADR-0066). Older ADRs that cite `docs/api.md` mean `docs/openapi.yaml`. The docs site (`docs/`, rendered by `web/`) is written for a developer: Get started, Guides, the REST API reference built from `docs/openapi.yaml`, and Self-hosting. ADRs and `CONTEXT.md` stay in the repo but are not on the site, and the docs build fails on an `ADR-NNNN` reference, an em or en dash, or a filler word in a page. `docs/self-hosting/mainnet.md` is the mainnet checklist.
- **Testing.** `pnpm test:offline` (unit + fake-store Coordinator + real-Postgres tiers, ADR-0034, ADR-0047) is what CI runs (`.github/workflows/ci.yml`), along with `web/`'s own tests and build. The live-chain tier, every test importing `test-support/*-fixtures`, runs only locally via `pnpm test`, since it spends testnet funds (ADR-0013); the Base and Solana volume runs also need `RUN_BASE_VOLUME=1` / `RUN_SOLANA_VOLUME=1` (ADR-0040), and the multisig runs `RUN_SQUADS=1` / `RUN_SAFE=1`. `scripts/flows/` (see its README) starts a local engine, drives each flow in `.scratch/flow-coverage/spec.md` against devnet and Base Sepolia, and screenshots the console; it is local only too. Live RPC URLs come from a gitignored `.env` (loaded by the test runner and by `src/config.ts`). If the default Postgres port is taken on your machine, pass `DATABASE_URL=postgres://dispatch:dispatch@localhost:<port>/dispatch` to `pnpm test:offline`.

### On `main` (through PR #108)

- `core-engine-scaffold`, `solana-chain-handler` (the first real chain), `relay-dispatch`, and `base-chain-handler` (the second real chain, #1 to #15 plus #20, #21 and #24), proven end to end against devnet and real Base Sepolia: fee-bump (ADR-0037), Bulk Call (ADR-0038), nonce gaps (ADR-0039), the opt-in volume run (ADR-0040), write-before-send (ADR-0041). `demo/base/` holds three Base Sepolia end-to-end demos.
- `solana-landing` (PR #35) and `solana-hardening` (PR #45): Solana expiry resubmitted by the Coordinator (ADR-0042) and proven by block height with a lag margin (ADR-0045), the Funding Check counting fees and rent (ADR-0043), concurrent sends (ADR-0044), Token-2022, priority fees, size-aware bundling, v0 Relay Dispatch, and the mainnet-readiness review's fixes.
- `production-signer` (ADR-0046): the Signer (`signer/`) gets the whole transaction, bearer auth (`SIGNER_AUTH_TOKEN` on both sides), per-address policy, an audit log on stdout, and `privy` and `aws-kms` backends; `keyfile` is dev only. The engine verifies every signature and maps policy refusals to `SIGNER_REFUSED`.
- `multisig-and-local-signer` and `safe-multisig-base` (ADR-0049 to ADR-0054): a Treasury, or a Multisig Sender whose transfers the engine proposes and executes and Approvers approve in the Squads or Safe app; a `local` encrypted-keystore Signer backend; and the independent verifier CLI (`verifier/`). Proven against devnet and Base Sepolia.
- The Signer pin check (ADR-0055): the engine refuses to start for a Multisig Sender whose key is unpinned, pinned elsewhere, or on a Signer too old to say.
- Nothing has run on mainnet.

### PR #158 (`integration` into `main`, open)

Lands `web-console`, `flag-rules`, `setup-tooling` and `named-senders` (specs in `.scratch/`; ADR-0056 to ADR-0060, ADR-0065 to ADR-0067), and closes #109 to #128, #134 to #138 and #140 to #149. The stacked PRs it replaces (#129 to #131, #133, #150 to #156) stay open for reference until it merges.

- The API process serves the operator console at `/console` and the docs at `/docs` from `web/`'s engine build; `web/` also builds the public landing page, which a self-hosted engine never serves (ADR-0065). The console signs in with a bearer token kept in `sessionStorage`, and `GET /v1/token` tells it which token it holds; the operator pages show only in an `OPERATOR_TOKEN` session.
- A Dispatch can be cancelled only before it is claimed (ADR-0056). Flag Rules (six kinds, optionally scoped to one Sender) are checked at submission and hold the whole Dispatch until someone with the Operator Token releases it or anyone cancels it; every release, cancel and rule change is an Operator Action (ADR-0057, ADR-0058).
- The API never calls the Signer; the worker reads each Sender's pins and records them (ADR-0059).
- A chain can have several named Senders in a senders file, chosen per Dispatch, with claims, the Funding Check, nonces, bundling and Proposals per Sender (ADR-0060).
- `pnpm dispatch init` writes the Signer config and `.env` and can start the services. `pnpm dispatch doctor`, the worker every five minutes, and `GET /v1/setup` run one registry of setup checks, per Sender (ADR-0067).
- Proven live on Solana devnet with two named Senders, a scoped rule, a hold and a release. Each feature was also run live on its own branch.

### `flow-coverage` (on top of `integration`, no PR yet)

`.scratch/flow-coverage/spec.md` and `.scratch/nonce-resilience/spec.md`; ADR-0061 to ADR-0064. Every kind of Dispatch seen and explained in the console, and a Base nonce taken by another sender no longer fails a payment. Everything below is merged into the branch and verified offline (`pnpm test:offline`, `web/` tests, both builds); each part was also run live on devnet or Base Sepolia on its own branch.

- The Known Asset registry: seeded from `*_KNOWN_TOKENS`, extended by operators with metadata read from the chain (#161, ADR-0061), and the console's Assets page with asset names everywhere (#162).
- Effects recorded once at confirmation and calls decoded on read by built-in decoders (#163, ADR-0063), and the contract registry of operator-added ABIs and Anchor IDLs, with the console's Contracts page and call view (#164). Migration `0029_known_contracts` carries a hand-written notify trigger that drizzle-kit does not generate.
- Who approved a Proposal and how many approvals remain (#165).
- The error catalogue in the console and Rejected Requests (#166, ADR-0062).
- A Base transaction whose nonce another sender took, and which never landed, is sent again at the next free nonce, up to 3 times; the worker records the nonces another sender used and reports them as `foreignActivity` and a `sender.exclusive` setup check; the console shows the resend and warns on the Sender (#171 to #174, ADR-0064). One engine per Sender stays the rule.
- `scripts/flows/` drives each flow against devnet and Base Sepolia and screenshots the console (#160).
- The Tokens setup check runs in the API and doctor, not the worker, which is never given the tokens.

### Unproven

- The multisig live runs (`RUN_SQUADS=1`, `RUN_SAFE=1`) with a Multisig Sender in a senders file, and so the Signer pin check against a live Signer.
- `init` starting the services under Docker Compose, and the setup checks against live Base.
- The AWS KMS backend against a real key (#61).
- The flow-coverage rows for Squads and Safe, and the after-change run of every flow (#167).
- Anything on mainnet.

### Open issues

Every open issue carries one status label (see above).

- `needs-triage`: #132 (one oversized Dispatch fails the others claimed in its Funding Check batch).
- `ready-to-go`: #159 (the fee balance check should count only its own Sender's fees), #168 (console gaps the baseline run found: Relay details, the Bulk Call label, fee-bump numbers, holds in the flow, every hash, the Sender card's headline coin), #169 (timeline order, the cancel reason on the Dispatch, revert reasons), #170 (two Postgres-tier tests fail intermittently: Node's clock against Postgres `now()`, and the docs reference tests under load).
- `in-progress`: #167 (the live run of every flow after the changes; needs the Base dev key topped up).
- `in-review`: #160 to #166 and #171 to #174 (on `flow-coverage`), and the PR #158 issues listed above, including #145, whose live criterion (one run per chain through a plain and a multisig Sender) is still unmet.
- `blocked`: #157 (Compose does not pass the senders file to the API and the worker), #175 (the Safe executor key, the foreign-nonce record write, duplicate warnings).
- `waiting`: #61 (needs operator AWS keys), #91 (a human checks that the Squads app shows a batch's contents), #96 (human checks before mainnet: Squads app labels and rent collector, Safe plan quotas, delegate removal, self-hosting).
