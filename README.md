# dispatchxyz

An open-source, self-hosted execution engine for blockchain transactions. You hand it payments or contract calls, or a transaction your own users already signed, and it handles the error-prone part of getting them onto a chain reliably: nonce sequencing, batching, delivery retries, stuck-transaction handling and confirmation tracking.

- [`docs/concept.md`](./docs/concept.md) — what this is and the scenarios it covers
- [`docs/api.md`](./docs/api.md) — the HTTP API (`POST`/`GET /v1/dispatch`)
- [`CONTEXT.md`](./CONTEXT.md) — vocabulary (Managed vs Relay Dispatch, Sender, Signer, Call, Retry Policy, …)
- [`docs/adr/`](./docs/adr/) — every architectural decision and why it was made
- [`AGENTS.md`](./AGENTS.md) — how this repo's specs, tickets and conventions fit together

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

**Before mainnet:** the only Signer here, `reference-signer/`, is for development. It reads keys from a committed file and its `/sign` endpoint has no authentication. A production deployment needs its own Signer backed by a real key store; that's the next feature, `.scratch/production-signer/spec.md` (ADR-0046, issues #47–#52). Neither chain has been run on mainnet yet.

## Running it

It has three processes, sharing one Postgres (ADR-0009): the **API** (`src/index.ts`, port 8420), the **worker** that actually sends and tracks transactions (`src/worker.ts`), and a **Signer** holding the sending wallet's keys (ADR-0002; `reference-signer/` is a development one, port 8421).

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
pnpm --dir reference-signer install && pnpm --dir reference-signer dev   # the dev Signer
pnpm dev:api        # in one terminal
pnpm dev:worker     # in another
```

Configuration is environment variables, documented in [`.env.example`](./.env.example). A local `.env` is loaded automatically, and real environment variables win. Chains are switched on by `ENABLED_CHAINS` (ADR-0019); `BASE_TRACE_RPC_URL` (a tracing-capable RPC) is only needed for Bulk Call's `allowFailure: true`. On Solana mainnet, use an RPC that serves full transaction history (`searchTransactionHistory`) and `getRecentPrioritizationFees`.

## Demos

- [`demo/base/`](./demo/base/README.md): native ETH, a deployed ERC-20, and 15 contract calls, each sent through the real HTTP API against Base Sepolia and checked on-chain.
- [`demo/solana/`](./demo/solana/README.md): Relay Dispatch of a transaction for a custom Anchor program on devnet.

## Tests

- `pnpm test:offline`: unit tests, the Coordinator against an in-memory store, and the real-Postgres tier (ADR-0034). This is what CI runs on every PR (`.github/workflows/ci.yml`). It needs a Postgres at `DATABASE_URL`.
- `pnpm test`: everything, **including the live-chain tests** against real Solana devnet and Base Sepolia (ADR-0013). They spend testnet funds from dev wallets and use RPC URLs from `.env` (`SOLANA_DEVNET_RPC_URL`, `BASE_SEPOLIA_RPC_URL`; public endpoints are the fallback, but they rate-limit). A test counts as live exactly when it imports a chain's `test-support/*-fixtures`.
- `RUN_BASE_VOLUME=1 pnpm test src/chain-handler/base/base-sepolia-volume.test.ts`: the opt-in Base volume run (100+ real transactions, a fee-bump, and a nonce audit against the chain, ADR-0040).
- `src/chain-handler/solana/devnet-volume.test.ts`: 500 real devnet payments, bundled. Unlike Base's, it is **not** opt-in, so every `pnpm test` spends about 0.5 devnet SOL. The Solana expiry tests wait out real blockhash expiry and take several minutes each.

## License

MIT (ADR-0025).
