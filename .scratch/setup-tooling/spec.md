Status: drafted 2026-11-01; not ticketed; open questions at the end

# Setup tooling: `init`, `doctor` and the console's Setup page

Specs it builds on: `.scratch/web-console/spec.md`, `.scratch/production-signer/spec.md`, `.scratch/multisig-and-local-signer/spec.md`. ADRs: 0002, 0019, 0046, 0050, 0055, 0057, 0059.

## Problem Statement

Setting up a Sender today means editing two configuration files by hand: the Signer's config, and the engine's environment. You also run the Signer's key command, fund the address, and restart. Nothing tells you what is missing until the engine refuses to start, a Dispatch fails `SIGNER_UNREACHABLE`, or the Funding Check says `INSUFFICIENT_FUNDS`. The startup checks exist (ADR-0055), but they stop at the first problem, they print to a log, and the console never sees them.

## Solution

Three tools over one list of checks:

- **`pnpm dispatch init`:** an interactive command that sets up a working engine. It asks which chains to enable and how each Sender signs, creates or registers the key in the Signer, writes the Signer config and the engine's environment, and finishes by running the same checks as `doctor`.
- **`pnpm dispatch doctor`:** a command that runs every check and prints a clear, grouped report: what passed, what is missing, and the exact step to fix each problem. It exits non-zero when anything fails, so a deploy pipeline can gate on it. `--json` gives the same report for machines.
- **Setup page in the console:** the same checks, as the worker last ran them, with each failing check's fix. Read-only.

Keys still never pass through the engine. `init` drives the Signer's own key tooling on the machine where the Signer runs, and the API still never calls the Signer (ADR-0059): the console shows what the worker recorded.

## User stories

1. As someone setting up Dispatch for the first time, I want one command that asks me a few questions and leaves me with a running, correctly configured engine on devnet or Sepolia.
2. As an operator, I want to add a second chain later without rewriting my configuration by hand.
3. As an operator, I want one command that tells me everything that is wrong with my setup at once, not one failure per restart.
4. As an operator, I want each problem to come with the exact command or setting that fixes it.
5. As an operator, I want my deploy to stop when the setup is broken, so I want `doctor` to exit non-zero.
6. As an operator, I want to see the same checks in the console, so I notice a low fee balance or an unpinned key without opening a terminal.
7. As a security reviewer, I want neither tool to print, log or send a private key, a token or a cloud secret, and I want the API process to stay away from the Signer.

## The checks

One registry, `src/setup/checks.ts`, a table of typed checks. Each check has an id, an area, a title, the places it can run, and a function returning `pass`, `warn` or `fail`. Each result carries a one-line finding and, unless it passed, a fix: a command to run or a setting to change, with its value.

Places a check can run: `cli` (doctor and init, with access to the config files and, if present, the Signer), `worker` (on every start and every five minutes, recorded for the console), or both.

| Area | Check | Fails when |
|---|---|---|
| Configuration | Environment parses | A required variable is missing or malformed. Each one is named, and every problem is reported, not just the first. |
| Configuration | Tokens | `AUTH_TOKEN` is the development default or under 32 characters; `OPERATOR_TOKEN` equals it (warn while it is unset). |
| Configuration | Enabled chains | `ENABLED_CHAINS` names a chain without a Sender address, or a Sender address is set for a chain that isn't enabled (warn). |
| Database | Reachable | The database can't be reached with `DATABASE_URL`. |
| Database | Migrated | There are migrations not yet applied (fix: `pnpm db:migrate`). |
| Chain | RPC reachable | The RPC for an enabled chain does not answer within the timeout. |
| Chain | Network | The network the RPC reports (genesis hash, chain id) differs from the configuration, or is mainnet while the operator chose a test network in `init` (warn). |
| Signer | Reachable | The worker's `SIGNER_URL` doesn't answer, or `SIGNER_AUTH_TOKEN` is refused. |
| Signer | Key held | The Signer has no key for a Sender address (ADR-0055's 404). |
| Signer | Pinned | A Multisig Sender's key is not pinned to its multisig or Safe (as at startup, ADR-0055). |
| Signer | Not reachable from the API | The API process has `SIGNER_URL` or `SIGNER_AUTH_TOKEN` set (ADR-0059). |
| Sender | Fee balance | The native balance can't pay for about a day of the engine's own fees (warn below a configurable floor, fail at zero). |
| Sender | Token balances | A known token's balance is zero (warn). |
| Multisig | Account exists | The Squads multisig or Safe address has no account or code on this network. |
| Multisig | Engine key is member or delegate | The member key isn't a Squads member, or the executor isn't a registered Safe delegate. |
| Console | Built | `web/dist/engine` is missing, so the API serves no console (warn). |

Checks share the engine's existing code paths: config parsing, the chain handlers' balance and network reads, the Signer client's policy read, and the multisig startup checks. They never re-implement them. Today's startup refusals stay as they are.

## `pnpm dispatch init`

- **Interactive by default**, with a scripted mode (`--yes` plus flags) for automation. It asks:
  1. Chains to enable.
  2. Network per chain (devnet or Sepolia by default; mainnet only behind an explicit "yes, mainnet" answer).
  3. RPC URL.
  4. Per chain, how the Sender signs: a new local encrypted key, an existing Privy wallet, an existing AWS KMS key, or `keyfile` for development only.
  5. Whether the Sender is a plain wallet, a Squads multisig or a Safe.
  6. Database URL.
- **Keys:**
  - A new local key is created by the Signer's own `keys new` command. The passphrase is read from the terminal and never echoed or written down.
  - Privy and AWS KMS keys are registered by id. `init` never creates cloud resources and never asks for cloud secrets beyond what the Signer's backend already reads from its own environment.
- **Files written:**
  - The Signer config, with a default policy per address (allowed chain ids; for a Multisig Sender, its pin), which the operator is told to tighten.
  - The engine's `.env`: new values only, existing lines kept, a backup taken first, file mode 0600. Random `AUTH_TOKEN`, `OPERATOR_TOKEN` and `SIGNER_AUTH_TOKEN` values are generated and written to the files, never printed.
- **Safe to run again.** Running it again shows the current setup and changes only what you choose. Adding a chain later is the same command.
- **Ends with `doctor`.** It runs the doctor checks and prints the address to fund for each chain, with a faucet link on test networks.

## `pnpm dispatch doctor`

- **Report:** grouped by area, one line per check: a pass, warn or fail mark (each with a text label, so the result never depends on colour alone), the check's title and the finding. Under each warn or fail, its fix, indented. A summary line at the end, for example "14 passed, 2 warnings, 1 problem".
- **Terminal behaviour:** colour only on a TTY and only without `NO_COLOR`. Checks run in parallel, with a spinner per area while they run. Total time is bounded by per-check timeouts.
- **Options:** `--json` prints the same results as JSON. `--only <area>` limits the run.
- **Exit code:** 0 when nothing failed, 1 on any failure, 2 when doctor itself could not run.
- **Secrets:** never printed. A finding names the variable, never its value.

## Setup page in the console

- **Data:** the worker runs the `worker` checks at start and every five minutes, and records the latest result per check, the same pattern as `signer_keys` (ADR-0059). `GET /v1/setup` (with `AUTH_TOKEN`) returns the recorded results with their time. The API itself also runs the few checks that need no Signer (database, migrations, console build), and the response marks which ran where.
- **Page:** "Setup", in the sidebar under Senders & Keys. A summary card ("All good" or "2 things need you"), then one card per area with a row per check: text status, finding, fix, and when it last ran. A failing check also shows in the Overview's "Needs attention" card. The design follows `.scratch/web-console/design.md`; status uses the pill table, text only.
- **Read-only.** The page never changes configuration, because that lives in files on the server.

## Out of scope

- Creating cloud resources (KMS keys, Privy wallets), creating a Squads multisig or a Safe, and funding wallets.
- Editing configuration from the browser.
- Several Senders per chain (Sender Pool, roadmap).
- Mainnet-specific checks beyond what the mainnet checklist already says. `doctor` links to it.

## Testing

- **Check registry:** each check unit-tested with fakes: a passing, a warning and a failing case, and the fix text for the last two.
- **`doctor`:** a snapshot of the human report and the JSON report from a fixed set of results, plus exit codes.
- **`init`:** scripted mode tested end to end in a temporary directory. It writes the Signer config and `.env`, keeps existing lines, takes the backup, sets mode 0600, and prints no secret. The output is scanned for the generated tokens.
- **Console:** the Setup page against fixture responses. The route is tested through `app.inject` and the store conformance suite.
- **Live:** `init` then `doctor` on a fresh machine-local setup against Solana devnet and Base Sepolia, each ending at "all passed" except the funding warning until the address is funded.

## Proposed issues

1. The check registry and the configuration, database, chain and console checks.
2. Signer, Sender and multisig checks, reusing the existing startup checks.
3. `pnpm dispatch doctor`: report, `--json`, `--only`, exit codes.
4. Worker check runs, the setup results table, and `GET /v1/setup`.
5. The console Setup page, and failing checks in Needs attention.
6. `pnpm dispatch init`: interactive and scripted, the Signer key step, safe `.env` and config writes.
7. Docs: the Self-hosting quickstart rewritten around `init` and `doctor`, and a Setup page section in the console guide.

## Open questions

1. Should `init` also start the services for you (with Docker Compose when Docker is present), or stop after writing configuration?
2. Fee floor for the "Fee balance" warning: a fixed amount per chain (for example 0.05 SOL, 0.005 ETH), or an estimate from the last 24 hours of fees?
3. Should a failing `doctor` check also block the worker from starting? Today only the ADR-0055 checks do. My recommendation is no: `doctor` reports, and startup refusals stay limited to unsafe states.
