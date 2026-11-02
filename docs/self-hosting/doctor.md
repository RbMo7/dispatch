# Setup checks

`pnpm dispatch doctor` runs the engine's setup checks and prints, for each one, what it found and how to fix it. The worker runs its checks at start and every five minutes, and records the results. The console's **Setup** page and [Get the setup checks](../openapi.yaml#get-the-setup-checks) show them. This page lists every check.

## Run doctor

Run it from the repository root. It reads the same environment and `.env` as the API and the worker.

```sh
pnpm dispatch doctor                    # every check, grouped by area
pnpm dispatch doctor --only signer      # one area: configuration, database, chain, signer, sender, multisig, console
pnpm dispatch doctor --json             # the same results as JSON
```

| Exit code | Meaning |
| --- | --- |
| `0` | No check failed. There may be warnings. |
| `1` | At least one check failed. |
| `2` | `doctor` could not run, such as on an unknown option. |

Each check ends in one of three statuses:

- `pass`: the check found what it needs.
- `warn`: something is missing or could not be read, and the engine still runs. A check that could not read what it checks warns with a finding that starts `not checked:`, and its fix is for the read.
- `fail`: the engine cannot send, or sends unsafely, until you fix it.

A warning or a failure carries a fix: a command to run, a setting and its value, or a step to take outside this machine, such as funding an address. A finding names a variable, never its value, and a URL only by its host.

Each check has a 10-second limit, and one that runs out fails with "did not finish within 10s". A chain check runs once per enabled chain, and a Sender check once per Sender. Its JSON `id` adds the chain, such as `sender.fees:solana`, and its title adds the chain's name:

```json
{
  "id": "sender.tokens:solana",
  "area": "sender",
  "title": "Token balances (Solana)",
  "chain": "solana",
  "status": "warn",
  "finding": "33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf holds no USDC, so a payment in it fails its Funding Check",
  "fix": { "step": "Send USDC to 33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf" }
}
```

With a [senders file](./configuration.md#the-senders-file), a Sender check's `id` also adds the Sender's name, such as `sender.fees:solana:treasury`, and its title names the Sender. On an engine with two Solana Senders, `payouts` and a new, unfunded `treasury`, the Signer and Sender areas print:

```text
Signer
  ✓ PASS  Reachable                            the Signer at SIGNER_URL (localhost:18621) answered and accepted SIGNER_AUTH_TOKEN
  ✓ PASS  Key held (payouts on Solana)         the Signer holds the ed25519 key for 33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf
  ✓ PASS  Key held (treasury on Solana)        the Signer holds the ed25519 key for Hd7W6MwuqSdmyNXvUnQGSQR9SKyevuY5fjs6jCVaMwPd
  ✓ PASS  Not reachable from the API           neither SIGNER_URL nor SIGNER_AUTH_TOKEN is set in Compose's api service

Sender
  ✓ PASS  Fee balance (payouts on Solana)      33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf holds 8.993171623 SOL; no fees paid in the last 24 hours to compare with
  ! WARN  Fee balance (treasury on Solana)     Hd7W6MwuqSdmyNXvUnQGSQR9SKyevuY5fjs6jCVaMwPd holds no SOL, so the first transaction cannot pay its fee
          fix: run solana airdrop 1 Hd7W6MwuqSdmyNXvUnQGSQR9SKyevuY5fjs6jCVaMwPd --url devnet
  ✓ PASS  Token balances (payouts on Solana)   no known tokens are configured
  ✓ PASS  Token balances (treasury on Solana)  no known tokens are configured
```

## Where each check runs

Not every check can run everywhere. Each check below names where it runs:

- **doctor**: `pnpm dispatch doctor`, and `pnpm dispatch init` at its end.
- **worker**: the worker, at start and every five minutes. A failing check never stops the worker.
- **API**: the API process, on each request to `GET /v1/setup`. The API never calls the Signer or a chain, so it runs only the database and console checks.

## Configuration

### Environment parses

Id `configuration.environment`. Runs in doctor and the worker.

Runs the engine's own parsers over its settings: `ENABLED_CHAINS`, `DATABASE_URL`, `SIGNER_URL`, `PORT`, `RPC_TIMEOUT_MS`, and each enabled chain's Sender and multisig variables. It fails with every problem at once, not only the first. The engine refuses to start on the same problems. Fix: set each variable the finding names to a valid value. [`.env.example`](../../.env.example) describes each one.

### Tokens

Id `configuration.tokens`. Runs in doctor and the worker.

Checks the API's bearer tokens, without showing them:

- It fails when `AUTH_TOKEN` is unset, is the development default `dev-secret`, or is shorter than 32 characters. Anyone who guesses it can submit and cancel Dispatches.
- It fails when `OPERATOR_TOKEN` equals `AUTH_TOKEN` or is shorter than 32 characters. An application holding the operator token could release its own held Dispatches.
- It warns when `OPERATOR_TOKEN` is unset. The console is then read-only, and no Flag Rule can hold a Dispatch.

Fix: set the token the finding names to the output of `openssl rand -hex 32`, a different value for each token, and restart the API. [Authentication](../authentication.md) explains both tokens.

### Enabled chains

Id `configuration.chains`. Runs in doctor and the worker.

Checks `ENABLED_CHAINS` against the Sender settings:

- It warns when `ENABLED_CHAINS` names no chain, because the engine then sends nothing.
- It fails when a chain is enabled but its Sender address, such as `SOLANA_SENDER_ADDRESS`, is empty.
- It warns when a Sender address is set for a chain that is not enabled, which usually means a chain was left out of `ENABLED_CHAINS` by mistake.

With a senders file, the per-chain Sender variables do not apply, and the check reads the file instead:

- It fails when an enabled chain has no Sender in the file.
- It warns when a per-chain Sender variable, such as `SOLANA_SENDER_ADDRESS`, is also set, because the engine ignores it.
- It passes with each chain's Senders by name and address, and marks the default: `solana sends from payouts (33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf, the default), treasury (Hd7W6MwuqSdmyNXvUnQGSQR9SKyevuY5fjs6jCVaMwPd)`.

Fix: set `ENABLED_CHAINS` to `solana`, `base` or `solana,base`, and give each enabled chain its Sender, in the per-chain variables or in the senders file.

## Database

### Reachable

Id `database.reachable`. Runs in doctor and the API.

Checks that the database at `DATABASE_URL` answers. The API and the worker store every Dispatch there, so nothing works without it. Fix: when the connection is refused, start Postgres with `docker compose up -d postgres`. Otherwise, set `DATABASE_URL` to a Postgres the engine can sign in to.

### Migrated

Id `database.migrated`. Runs in doctor and the API.

Checks that the database has every migration in `drizzle/`. An engine on a database with missing tables fails at its first read or write. It fails with the number of migrations not applied, and warns when the database does not answer. Fix: run `pnpm db:migrate`.

## Chain

### RPC reachable

Id `chain.rpc`. Runs in doctor and the worker, once per enabled chain.

Checks that the chain's RPC, `SOLANA_RPC_URL` or `BASE_RPC_URL`, answers. The engine reads balances and sends every transaction through it. Fix: set the variable to an RPC URL that answers. The public endpoints rate-limit, so use your own RPC for real traffic.

### Network

Id `chain.network`. Runs in doctor and the worker, once per enabled chain.

Checks which network the RPC serves:

- On Solana it reads the genesis hash and passes for mainnet-beta, devnet or testnet. It warns for any other cluster, such as a local validator.
- On Base it fails when the RPC's chain ID differs from `BASE_CHAIN_ID`. The engine refuses to start in that case, because a transaction signed for one chain ID is invalid on another.

Fix: point the RPC variable at the network you mean, or on Base set `BASE_CHAIN_ID` to the chain the RPC serves.

## Signer

### Reachable

Id `signer.reachable`. Runs in doctor and the worker.

Checks that the Signer at `SIGNER_URL` answers and accepts `SIGNER_AUTH_TOKEN`, by reading the policy of a Sender's key. That read never signs anything. It fails when `SIGNER_AUTH_TOKEN` is unset, when the Signer refuses the token, when nothing answers, or when the answer is not from a Signer. It warns when no enabled chain has a Sender to ask about. Without the Signer, every payment fails with `SIGNER_UNREACHABLE`. Fix: set `SIGNER_AUTH_TOKEN` to the Signer's own value, or start the Signer with `docker compose up -d signer`, or point `SIGNER_URL` at it.

### Key held

Id `signer.key`. Runs in doctor and the worker, once per Sender.

Checks that the Signer holds the key the engine signs with: the Sender's own key, or a Multisig Sender's member key or executor. It fails when the Signer has no key for that address, and warns when the Signer is too old to say. Fix: add the address to the Signer's config (`SIGNER_CONFIG`) with its backend and restart the Signer. [Set up a Signer](./signer.md#3-write-the-config-file) shows the config.

### Pinned

Id `signer.pinned`. Runs in doctor and the worker, once per Multisig Sender.

Checks that the Signer pins the engine's key to its multisig: `policy.allowedMultisig` on Squads, or `policy.allowedSafe` and `policy.chainIds` on Safe. An unpinned key could sign any transaction, not only that multisig's proposals and executions. The worker refuses to start for a Multisig Sender whose key is not pinned. Fix: set the pin in the Signer's config and restart the Signer. [Keys for a Multisig Sender](./signer.md#keys-for-a-multisig-sender) explains the pin.

### Not reachable from the API

Id `signer.api`. Runs in doctor only.

Checks that the API process has neither `SIGNER_URL` nor `SIGNER_AUTH_TOKEN`. Only the worker needs the Signer. An API that can reach the Signer widens what a compromised API host can do. It reads Compose's `api` service when `docker compose config` can resolve it. Otherwise it reads the environment the API would start with here, `.env` and the shell. Fix: unset both settings where the API runs. In Compose, set them to `''` in the `api` service.

## Sender

### Fee balance

Id `sender.fees`. Runs in doctor and the worker, once per Sender.

Checks that the key that pays fees holds enough of the native asset, SOL or ETH. For a Multisig Sender that key is the member key or the executor. It compares the balance with the fees the engine paid on that chain in the last 24 hours, read from the chain for the latest 20 transactions and scaled to the day's count:

- It fails when the balance is zero and the engine sent transactions in the last 24 hours.
- It warns when the balance would not cover the last 24 hours' fees, or when it is zero on a new install with no history.

Fix: send the native asset to the address. On Solana devnet the fix is `solana airdrop 1 <address> --url devnet`.

### Token balances

Id `sender.tokens`. Runs in doctor and the worker, once per Sender.

Checks the Sender's balance of each enabled token in the Known Asset registry (`GET /v1/assets`): the ones in `SOLANA_KNOWN_TOKENS` or `BASE_KNOWN_TOKENS` and the ones added through the API. Run from your machine, it reads the registry from `DATABASE_URL`, or only the variables when the database can't be read. It warns for each token the Sender holds none of, because every payment in that token fails its [Funding Check](../lifecycle.md#the-funding-check). It passes when no tokens are configured. Fix: send the token to the Sender, or disable the token (or remove it from the variable) if you do not pay in it.

### Used only by this engine

Id `sender.exclusive`. Runs in doctor and the worker, once per plain Base Sender.

A Sender belongs to one engine. On each pass the worker compares the wallet's nonce on chain with the nonces this engine sent, and records every nonce something else used: another engine with the same key, a wallet app or a script. This check reads those records from `DATABASE_URL` and warns when any was seen in the last 24 hours, with how many and which. The engine sends a payment again when another sender took its nonce, so nothing is lost, but payments can land out of order and fail after 3 tries with `NONCE_ALREADY_USED`. `GET /v1/senders` shows the same records as `foreignActivity`. Fix: stop whatever else sends from the address, or give this engine a Sender of its own. To split work, use [named Senders](./configuration.md#the-senders-file) in one engine.

## Multisig

### Account exists

Id `multisig.account`. Runs in doctor and the worker, once per Multisig Sender.

Runs the multisig startup checks the worker runs, and reports the ones about the account. On Squads it fails when the multisig cannot be read, does not exist, is not owned by Squads v4, or when `SOLANA_SENDER_ADDRESS` is set to something other than its vault. On Safe it fails when the Safe Transaction Service does not answer or serves another chain, or when the Safe does not exist or is not version 1.3.0 or 1.4.1. It warns on the startup warnings, such as a Safe with a threshold of 1 or no `BASE_SAFE_API_KEY`. The worker refuses to start on the same failures. Fix: set `SOLANA_MULTISIG_ADDRESS` or `BASE_SAFE_ADDRESS` to a multisig on the network the RPC serves. [Set up a multisig Sender](./multisig.md) covers each one.

### Engine key is member or delegate

Id `multisig.member`. Runs in doctor and the worker, once per Multisig Sender.

Checks the engine's own key against the multisig:

- On Squads the member key must be a member with exactly the Initiate and Execute permissions, mask 5, and never Vote.
- On Safe the executor must be a registered delegate of the Safe and must not be one of its owners.

A key that can vote could approve its own proposals. A key that is not a member or delegate cannot propose at all. The worker refuses to start on the same failures. Fix: change the member's permissions in the Squads app, or have a Safe owner register the executor as a delegate, as [Set up a multisig Sender](./multisig.md) describes.

## Console

### Built

Id `console.built`. Runs in doctor and the API.

Checks that `web/dist/engine` exists. Without it the API serves no console and no docs. It warns, and the API works without it. Fix: run `pnpm --dir web install && pnpm --dir web build`, then restart the API. The Docker image builds it for you.
