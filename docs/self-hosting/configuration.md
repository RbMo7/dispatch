# Configuration

The engine and the Signer are configured only by environment variables. This page lists every variable either one reads.

The engine's API and worker read the same variables from the environment, and also from a `.env` file in the folder they start in, if there is one. A real environment variable wins over `.env`. [`.env.example`](../../.env.example) has the same names with comments. The Signer reads only its environment, never `.env`.

Restart a process after you change one of its variables. Nothing is reloaded while it runs.

## Engine: core

| Variable | Default | What it does | When to change it |
| --- | --- | --- | --- |
| `PORT` | `8420` | The API's HTTP port. The worker does not listen on a port. | When 8420 is taken |
| `DATABASE_URL` | `postgres://dispatch:dispatch@localhost:5432/dispatch` | The Postgres both the API and the worker use. They must point at the same database. | Always, outside local development |
| `AUTH_TOKEN` | `dev-secret` | The bearer token every `/v1` request must carry, and the console's sign-in token. There is one per engine, with no users or scopes. | Always. Use `openssl rand -hex 32`. |
| `OPERATOR_TOKEN` | unset | API only. A second bearer token that can do everything `AUTH_TOKEN` can, plus release held Dispatches, write Flag Rules and read the activity record. Unset, those routes answer `403`. The API refuses to start when it is set but empty, or equal to `AUTH_TOKEN`. | When you use Flag Rules. A different random value from `AUTH_TOKEN`. |
| `ENABLED_CHAINS` | empty, no chains | Comma-separated chains to serve: `base`, `solana`, or `base,solana`. A chain that is not listed is refused with `CHAIN_NOT_ENABLED`, and none of its other settings are read. | To add or remove a chain. Never remove one with transactions in flight (issue #57). |
| `SENDERS_FILE` | `senders.json` if it exists | A JSON file naming several Senders per chain, each with its own mode (`single`, `squads` or `safe`) and keys, and an optional default per chain. [The senders file](#the-senders-file) describes it. A path that does not exist is a startup error. With a senders file, the per-chain Sender variables below are ignored. Without one, they describe one Sender per chain, named `default`. | To pay from more than one Sender on a chain, such as a hot `payouts` Sender beside a multisig `treasury` |
| `SIGNER_URL` | `http://localhost:8421` | Worker only. Where the worker reaches the Signer. The API never calls the Signer, so leave it unset in the API's environment. | Always, in a deployment: the Signer's address on your private network |
| `SIGNER_AUTH_TOKEN` | unset | Worker only. The bearer token the worker sends to the Signer. Must equal the Signer's own. Unset, the worker starts, logs a warning, and every signing request gets `401`. Leave it unset in the API's environment. | Always on the worker, except for a Relay-only engine |
| `DEFAULT_RETRY_POLICY` | `false` | The [Retry Policy](../lifecycle.md#retry-policy-and-stuck-transactions) for a Dispatch whose request does not set `retryPolicy`. Only the exact value `true` turns it on. | To let the engine fee-bump stuck Base transactions by default |
| `RPC_TIMEOUT_MS` | `15000` | The deadline, in milliseconds, for each outbound RPC or Signer call. A slower answer counts as unreachable. | When your RPC or Signer is slow and you see timeouts |
| `LOG_LEVEL` | `info` | The engine's log level: `trace`, `debug`, `info`, `warn`, `error` or `fatal`. Logs are JSON lines on stdout. | `debug` while you investigate |

## The senders file

The senders file names the Senders of each chain. The API and the worker both read it at startup, from `SENDERS_FILE`, or from `senders.json` in the folder they start in. Without the file, the per-chain Sender variables describe one Sender per chain, named `default`, and nothing else changes. [Send from more than one Sender](../guides/multiple-senders.md) walks through a setup, and [`senders.example.json`](../../senders.example.json) has one of each mode.

The file is a JSON object keyed by chain. Each chain has `senders`, an object keyed by Sender name, and an optional `default`:

```json
{
  "solana": {
    "default": "payouts",
    "senders": {
      "payouts": { "address": "33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf" },
      "treasury": {
        "mode": "squads",
        "multisig": "4AzEDD9wGkvTs4hpRNGZ44tgt2xCZbwoFWNKZs28UkuC",
        "memberKey": "8DyMoRsmCavhT6Ev8kxsX7YjzJaD6hUdjxirr1yqDgwV",
        "approvers": { "2xUDRfJQTDjPuokctLdyAStss7fU3Cv1bZCgtRidCXwt": "Priya, finance" }
      }
    }
  },
  "base": {
    "default": "payouts",
    "senders": {
      "payouts": { "address": "0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A" },
      "treasury": {
        "mode": "safe",
        "safe": "0x5afe000000000000000000000000000000005afe",
        "executor": "0x1Dd9661FAb2d82731E033c21C46BA009633bf558"
      }
    }
  }
}
```

Each Sender takes the fields of its `mode`, and any other field is a startup error:

| `mode` | Chain | Required | Optional |
| --- | --- | --- | --- |
| `single`, or left out | both | `address`: the Sender, whose key the Signer holds | none |
| `squads` | `solana` | `multisig`: the Squads multisig account, not its vault. `memberKey`: the engine's own key, which proposes and executes. | `approvalDeadlineMs`, `approvalRewatchWindowMs`, `approvers` |
| `safe` | `base` | `safe`: the Safe. `executor`: the engine's own key, a registered delegate and never an owner. | `txServiceUrl`, `apiKey`, `approvalDeadlineMs`, `approvalRewatchWindowMs`, `bundleLimit`, `approvers` |

The optional fields mean what the matching variables mean in [Solana Multisig Sender](#solana-multisig-sender) and [Base Safe Sender](#base-safe-sender), with the same defaults. The durations and `bundleLimit` are positive whole numbers, not strings. A Safe Sender without `apiKey` uses `BASE_SAFE_API_KEY`. A Squads Sender pays from its multisig's vault (index 0), and a Safe Sender from its Safe.

`approvers` names the people who vote, so the console and the `approval` block show "Priya, finance" instead of an address. It maps an Approver's address (a Squads member, or a Safe owner) to a label of 1 to 40 characters. It changes nothing about who may approve: that is the multisig's own member or owner list, read from the chain. An Approver with no label is shown by address.

The engine refuses to start, and lists every problem at once, when:

- a Sender name is not 1 to 40 lowercase letters, digits or hyphens, or appears twice on a chain;
- a chain in `ENABLED_CHAINS` has no Senders in the file;
- `default` names no Sender of its chain;
- two Senders on a chain share an address, including a Multisig Sender's engine key;
- an address is not valid on its chain, or a mixed-case Base address has a wrong checksum;
- `approvers` is not an object, lists an address twice, or has an empty label or one over 40 characters.

A chain in the file but not in `ENABLED_CHAINS` is not read. Without `default`, every Dispatch on the chain must name its Sender, or it is refused with `SENDER_REQUIRED`. If any per-chain Sender variable, such as `SOLANA_SENDER_ADDRESS` or `BASE_SAFE_ADDRESS`, is set for a chain the file describes, the engine logs a warning that it ignores it.

## Solana

Read only when `solana` is in `ENABLED_CHAINS`.

| Variable | Default | What it does | When to change it |
| --- | --- | --- | --- |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | The Solana RPC. Its cluster decides devnet or mainnet. | Always, for real traffic. The public endpoint rate-limits. On mainnet, use an RPC that serves full transaction history (`searchTransactionHistory`) and `getRecentPrioritizationFees`. |
| `SOLANA_SENDER_ADDRESS` | empty. In multisig mode, the vault derived from `SOLANA_MULTISIG_ADDRESS`. | The Sender's address. The Signer must hold its key. | Always in single mode. Leave it unset in multisig mode. If set there, it must equal the vault. |
| `SOLANA_KNOWN_TOKENS` | empty | The tokens a `payment` may name, comma-separated, as `SYMBOL:mint:decimals`, with `:token-2022` appended for a Token-2022 mint. Each is checked against its mint at startup. Example: `USDC:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU:6` (devnet USDC). | To pay in a token |
| `SOLANA_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` | `0`, no priority fee | A priority fee in micro-lamports per compute unit, on every transaction the engine builds. With any fee set, each transaction's compute-unit limit comes from a simulation, so the fee is paid on real usage. `auto` prices each transaction from recent network fees (75th percentile), never above the ceiling below. It costs more, so it is off by default. | On a congested mainnet |
| `SOLANA_MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` | `0` | The ceiling for an `auto` price. Required above 0 when the price is `auto`, or the engine refuses to start. | With `auto` |
| `SOLANA_SEND_CONCURRENCY` | `4` | How many Solana transactions one worker sends at once. Solana has no nonces to keep in order. A whole number of at least 1. | Lower it if your RPC rate-limits you. Raise it for volume. |

### Solana Multisig Sender

Read only when `SOLANA_SENDER_MODE=multisig`. [Set up a multisig Sender](./multisig.md#squads-on-solana) is the runbook.

| Variable | Default | What it does | When to change it |
| --- | --- | --- | --- |
| `SOLANA_SENDER_MODE` | `single` | `multisig` pays from a Squads v4 multisig's vault (index 0). Anything else but `single` is a startup error. | To use a Multisig Sender |
| `SOLANA_MULTISIG_ADDRESS` | none | The Squads multisig account, not its vault. Required in multisig mode, and an error in single mode. | In multisig mode |
| `SOLANA_MULTISIG_MEMBER_ADDRESS` | none | The engine's member key: proposes, executes and pays fees and Proposal rent. Must be ed25519, differ from the multisig, and be held by the Signer. Required in multisig mode, and an error in single mode. | In multisig mode |
| `SOLANA_APPROVAL_DEADLINE_MS` | `259200000` (72 hours) | How long a Proposal waits for approval, from its creation, before its Calls are `abandoned` with `APPROVAL_TIMEOUT`. A whole number above zero. | Make it longer than your Approvers' voting time plus any time lock |
| `SOLANA_APPROVAL_REWATCH_WINDOW_MS` | `2592000000` (30 days) | How long, from the timeout, the engine keeps reading a timed-out Proposal for a late execution or rejection | Rarely |

## Base

Read only when `base` is in `ENABLED_CHAINS`.

| Variable | Default | What it does | When to change it |
| --- | --- | --- | --- |
| `BASE_RPC_URL` | `https://sepolia.base.org` | The Base RPC | Always, for real traffic |
| `BASE_CHAIN_ID` | `84532` (Base Sepolia) | The chain ID. The engine refuses to start if the RPC reports a different one. | `8453` for Base mainnet |
| `BASE_SENDER_ADDRESS` | empty. In Safe mode, the executor. | The Sender's address. The Signer must hold its key. | Always in single mode. Leave it unset in Safe mode. If set there, it must equal the executor. |
| `BASE_KNOWN_TOKENS` | empty | The ERC-20 tokens a `payment` may name, comma-separated, as `SYMBOL:contractAddress:decimals`. Example: `USDC:0x036CbD53842c5426634e7929541eC2318f3dCF7e:6` (Base Sepolia USDC). | To pay in a token |
| `BASE_FEE_BUMP_PERCENT` | `15` | The least percentage both `maxFeePerGas` and `maxPriorityFeePerGas` rise by on a fee bump. Nodes require at least 10%. | If replacements are refused as underpriced |
| `BASE_STUCK_AFTER_MS` | `60000` | How long a transaction may stay pending after its latest send before it counts as stuck, and is rebroadcast or fee-bumped | Rarely |
| `BASE_MAX_FEE_BUMPS` | `5` | The most fee-bump attempts per Call, failed ones included. After that the latest version waits out the 15-minute timeout. | To cap what a stuck transaction can cost |
| `BASE_BULK_CALL_MAX_BATCH_SIZE` | `50` | The most items in one Bulk Call transaction. A request's `maxBatchSize` cannot exceed it. | To allow larger or force smaller bundles |
| `BASE_TRACE_RPC_URL` | empty | A tracing RPC (`debug_traceTransaction`). Bulk Call's `allowFailure: true` needs it to read per-item outcomes. | To use `allowFailure: true` |

### Base Safe Sender

Read only when `BASE_SENDER_MODE=safe`. [Set up a multisig Sender](./multisig.md#safe-on-base) is the runbook. Every Safe setting is an error in single mode.

| Variable | Default | What it does | When to change it |
| --- | --- | --- | --- |
| `BASE_SENDER_MODE` | `single` | `safe` pays from a Safe | To use a Safe Sender |
| `BASE_SAFE_ADDRESS` | none | The Safe, version 1.3.0 or 1.4.1. A mixed-case address needs a correct checksum. Required in Safe mode. | In Safe mode |
| `BASE_SAFE_EXECUTOR_ADDRESS` | none | The engine's executor: submits `execTransaction`, pays gas, owns the nonce. Must not be an owner, must be a registered delegate, and must differ from the Safe. Required in Safe mode. | In Safe mode |
| `BASE_SAFE_TX_SERVICE_URL` | the hosted service for chain 8453 (`https://api.safe.global/tx-service/base`) or 84532 (`…/basesep`) | The Safe Transaction Service's base URL, without `/api`. Required for any other chain ID. | To self-host the service |
| `BASE_SAFE_API_KEY` | none | The service's API key from `developer.safe.global`, sent as a bearer token and never logged. Optional in code, needed in production: without it the hosted service allows 2 requests a second and 5,000 a month, and the engine warns at startup. | Always, in production |
| `BASE_APPROVAL_DEADLINE_MS` | `259200000` (72 hours) | How long a Proposal waits, from its creation | Make it longer than your owners' voting time |
| `BASE_APPROVAL_REWATCH_WINDOW_MS` | `2592000000` (30 days) | How long, from the timeout, the engine keeps reading a timed-out Proposal | Rarely |
| `BASE_SAFE_BUNDLE_LIMIT` | `50` | The most payments in one Proposal (one MultiSend). A whole number from 1 to 300. The verifier's `--bundle-size` must equal it. | To trade fewer Proposals against larger ones |

## Signer

The Signer reads these from its own environment. [`signer/README.md`](../../signer/README.md) is the reference for its config file and policy rules.

| Variable | Default | What it does | When to change it |
| --- | --- | --- | --- |
| `SIGNER_AUTH_TOKEN` | none, required | The bearer token the worker must send. The Signer refuses to start without one. | Always. A fresh random value per environment. |
| `SIGNER_CONFIG` | none, required | The path to the JSON file that maps each address to its `curve`, `backend`, `keyRef` and optional `policy` | Always |
| `PORT` | `8421` | The Signer's HTTP port. It listens on every interface, in plain HTTP. | When 8421 is taken |
| `SIGNER_KEYFILE` | none | The `keyfile` backend's JSON file of raw keys. Development only. Required only if the config names `keyfile`. | Never in production |
| `SIGNER_KEYSTORE_DIR` | none | The `local` backend's directory of encrypted key files. Required only if the config names `local`. Also read by `pnpm signer keys`. | With `local` |
| `SIGNER_KEYSTORE_PASSPHRASE` | none | The `local` backend's passphrase. Set this or the next one, not both. | Prefer the file |
| `SIGNER_KEYSTORE_PASSPHRASE_FILE` | none | The path to a file holding the passphrase, such as a mounted secret | With `local` |
| `PRIVY_APP_ID` | none | The Privy app's ID. Required only if the config names `privy`. | With `privy` |
| `PRIVY_APP_SECRET` | none | The Privy app's secret. Required only if the config names `privy`. | With `privy` |
| `PRIVY_AUTHORIZATION_KEY` | none | The private key of a Privy authorization key, as Privy shows it (`wallet-auth:…`). When set, the Signer signs every Privy request with it, so a leaked app secret alone cannot sign. | Always, with `privy` |

The `aws-kms` backend has no variables of its own. The AWS SDK finds the region and credentials through its standard provider chain: `AWS_REGION`, then `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, a profile (`AWS_PROFILE`), or the role the Signer runs under. Prefer a role.

## Test-only variables

`.env.example` also lists variables only the test suite reads: the testnet RPCs `SOLANA_DEVNET_RPC_URL` and `BASE_SEPOLIA_RPC_URL`, and the `RUN_*` switches with their keys for the opt-in live runs. Neither the engine nor the Signer reads them. The repository's README describes each run.
