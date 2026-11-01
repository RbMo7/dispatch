# dispatchxyz

An open-source, self-hosted execution engine for blockchain transactions. You hand it payments or contract calls, or a transaction your own users already signed, and it handles the error-prone part of getting them onto a chain reliably: nonce sequencing, batching, delivery retries, stuck-transaction handling and confirmation tracking.

The documentation is in [`docs/`](./docs/), and the API process serves it as a site at `/docs`:

- [`docs/about.md`](./docs/about.md) and the rest of Get started: what this is, the [Quickstart](./docs/quickstart.md) to a confirmed payment on Base Sepolia or Solana devnet, authentication, requests, errors, the Dispatch lifecycle, pagination and polling
- [`docs/guides/`](./docs/guides/): task walk-throughs, from a batch of payments to Relay, Bulk Call, a multisig, cancelling and tracking
- [`docs/openapi.yaml`](./docs/openapi.yaml): the HTTP API, every route, parameter, status and body, with real examples. The site's reference pages are built from it, and `src/api/openapi.contract.test.ts` holds the routes to it
- [`docs/self-hosting/`](./docs/self-hosting/): install, every environment variable, the Signer, a multisig Sender, the console, troubleshooting and the mainnet checklist
- [`CONTEXT.md`](./CONTEXT.md): vocabulary (Managed vs Relay Dispatch, Sender, Signer, Call, Retry Policy, and the rest)
- [`docs/adr/`](./docs/adr/): every architectural decision and why it was made. These stay in the repo and are not part of the site
- [`AGENTS.md`](./AGENTS.md): how this repo's specs, tickets and conventions fit together

## Status

Two chains are shipped and proven end to end against their real test networks:

| | Solana (devnet) | Base (Sepolia) |
|---|---|---|
| Managed Dispatch: payments (native + tokens) and raw contract calls | ✓ | ✓ |
| Relay Dispatch: broadcast a transaction the caller signed | ✓ legacy and v0 | ✓ EIP-1559 |
| Tokens | SPL and Token-2022, checked against their mints at startup | ERC-20 |
| Bundling | native, several instructions per transaction, sized to fit | Bulk Call via a caller-named `aggregate3Value` aggregator (ADR-0038) |
| Parallel sends | 4 transactions in flight per worker by default (ADR-0044) | sequential, nonce order |
| Stuck transactions | resend while the blockhash is valid, then resubmit once it provably expired (ADR-0042, ADR-0045) | rebroadcast, and fee-bump when Retry Policy is on (ADR-0037) |
| Fees | optional priority fee, fixed or automatic with a ceiling; compute-unit limit from simulation | EIP-1559 estimate |
| Funding Check | payments plus SOL for fees and new token-account rent (ADR-0043) | payments |
| Confirmation | `confirmed`/`finalized` commitment | L2 inclusion (~2s), plus a reorg safety net (ADR-0036) |

Across both, every transaction is written down before it is sent, so a crash, a restart or a timeout can't lose track of one that may land (ADR-0041), and a failed send never leaves a nonce gap (ADR-0039).

Not built yet: webhooks (callers poll today, ADR-0023), Ethereum L1 as its own chain (ADR-0035), a Sender Pool of several sending wallets (ADR-0016), and Solana durable nonces (ADR-0007, #44).

**Before mainnet:** follow [`docs/self-hosting/signer.md`](./docs/self-hosting/signer.md), the Signer runbook, and clear [`docs/self-hosting/mainnet.md`](./docs/self-hosting/mainnet.md). The Signer, `signer/`, picks a key backend per address from its config (`SIGNER_CONFIG`), enforces a per-address policy, and audits every request as a JSON line on stdout. Its production backends are `privy` (Privy server wallets) and `aws-kms`, for both chains; `keyfile` reads raw keys from a file and is for development only ([`signer/README.md`](./signer/README.md)). Compose runs it with the dev keys (`signer/signer.config.dev.json`) and a dev bearer token shared with the engine (`SIGNER_AUTH_TOKEN`); replace the keys, the config and the token in any real deployment. The KMS backend has not yet been run against real KMS (#61), and neither chain has been run on mainnet yet.

## Running it

It has three processes, sharing one Postgres (ADR-0009): the **API** (`src/index.ts`, port 8420), the **worker** that actually sends and tracks transactions (`src/worker.ts`), and a **Signer** holding the sending wallet's keys (ADR-0002; `signer/`, port 8421). The Signer refuses to start unless every address in its config matches the key behind it.

With Docker:

```sh
cp .env.example .env    # set AUTH_TOKEN, ENABLED_CHAINS, each chain's RPC URL and Sender address
docker compose up -d postgres && pnpm install && pnpm db:migrate   # migrations run from the host
docker compose up
```

Compose passes `.env` to the API and worker containers; the database and Signer addresses are wired by Compose itself.

Or locally (Node 22, pnpm):

```sh
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm --dir signer install
SIGNER_AUTH_TOKEN=dev-only-signer-token pnpm --dir signer dev   # the dev keys; set the same token in .env
pnpm dev:api        # in one terminal
pnpm dev:worker     # in another
```

Configuration is environment variables, documented in [`docs/self-hosting/configuration.md`](./docs/self-hosting/configuration.md) and [`.env.example`](./.env.example). A local `.env` is loaded automatically, and real environment variables win. Chains are switched on by `ENABLED_CHAINS` (ADR-0019); `BASE_TRACE_RPC_URL` (a tracing-capable RPC) is only needed for Bulk Call's `allowFailure: true`. On Solana mainnet, use an RPC that serves full transaction history (`searchTransactionHistory`) and `getRecentPrioritizationFees`.

### Checking a setup

`pnpm dispatch doctor` checks the setup in this directory's environment and `.env`: configuration, the database and its migrations, each enabled chain's RPC and network, the Signer (reachable, token accepted, key held, a Multisig Sender's key pinned, and no Signer settings in the API's environment), the fee and token balances, the multisig, and the console build. It prints one line per check, PASS, WARN or FAIL, and the step that fixes each warning and failure. It never prints a secret, only the name of the variable that holds it.

```sh
pnpm dispatch doctor                    # every check, grouped by area
pnpm dispatch doctor --only signer      # one area: configuration, database, chain, signer, sender, multisig, console
pnpm dispatch doctor --json             # the same results as JSON
```

It exits 0 when nothing failed, 1 when a check failed (so a deploy can stop on it), and 2 when it could not run. The fee check compares the fee payer's balance with the fees the engine paid on that chain in the last 24 hours, read from the chain for the latest 20 Transactions; with no history yet it warns only at a zero balance.

## Console

`web/` holds the operator console, the docs site and the landing page ([`web/README.md`](./web/README.md)). Build it with `pnpm --dir web install && pnpm --dir web build`, and the API serves the console at `/console` and the docs at `/docs`, redirecting `/` to the console. Without a build the API serves only the API. The console's pages are not built yet; `/console/_primitives` shows the design system they will use.

## Demos

- [`demo/base/`](./demo/base/README.md): native ETH, a deployed ERC-20, and 15 contract calls, each sent through the real HTTP API against Base Sepolia and checked on-chain.
- [`demo/solana/`](./demo/solana/README.md): Relay Dispatch of a transaction for a custom Anchor program on devnet.

## Tests

- `pnpm --dir signer test`: the Signer's own tests, all offline. Install its dependencies first (`pnpm --dir signer install`); the root `pnpm typecheck` and `pnpm lint` check `signer/` too and need them.
- `pnpm --dir web test`: the pill contrast check (`web/scripts/check-contrast.ts`) and the web component tests. Install first with `pnpm --dir web install`; the root `pnpm lint` checks `web/` too and needs it.
- `pnpm test:offline`: unit tests, the Coordinator against an in-memory store, and the real-Postgres tier (ADR-0034). This is what CI runs on every PR (`.github/workflows/ci.yml`). It needs a Postgres at `DATABASE_URL`.
- `pnpm test`: everything, **including the live-chain tests** against real Solana devnet and Base Sepolia (ADR-0013). They spend testnet funds from dev wallets and use RPC URLs from `.env` (`SOLANA_DEVNET_RPC_URL`, `BASE_SEPOLIA_RPC_URL`; public endpoints are the fallback, but they rate-limit). A test counts as live exactly when it imports a chain's `test-support/*-fixtures`.
- `RUN_BASE_VOLUME=1 pnpm test src/chain-handler/base/base-sepolia-volume.test.ts`: the opt-in Base volume run (100+ real transactions, a fee-bump, and a nonce audit against the chain, ADR-0040).
- `RUN_SOLANA_VOLUME=1 pnpm test src/chain-handler/solana/devnet-volume.test.ts`: the opt-in Solana volume run (500 real devnet payments, bundled, about 0.55 devnet SOL). The Solana expiry tests, which do run in `pnpm test`, wait out real blockhash expiry and take several minutes each.
- `RUN_PRIVY=1 pnpm test src/signer/privy-e2e.test.ts`: Privy server wallets signing a Base Sepolia and a Solana devnet transfer through the real Signer, and a Signer without the authorization key refused. It needs an operator's Privy app and two wallets owned by its authorization key (`PRIVY_*` in `.env.example`); the wallets are topped up from the dev Senders when low.
- `RUN_AWS_KMS=1 pnpm test src/signer/aws-kms-e2e.test.ts`: an AWS KMS key signing a Base Sepolia transfer through the real Signer, and with `AWS_KMS_ED25519_KEY_ID` an Ed25519 key signing a Solana devnet transfer. It needs an operator's KMS keys and AWS credentials (`AWS_KMS_*` in `.env.example`). Not yet run against real KMS (#61).

## License

MIT (ADR-0025).
