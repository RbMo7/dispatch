# Install and run

Dispatch is three processes sharing one Postgres database: the **API** (`src/index.ts`, port 8420), the **worker** that sends and tracks transactions (`src/worker.ts`), and the **Signer** that holds the Senders' keys (`signer/`, port 8421). `pnpm dispatch init` sets them up and starts them with Docker Compose. `pnpm dispatch doctor` checks the result and tells you how to fix each problem.

## Before you start

You need Node.js 22 or later, pnpm 10 (`corepack enable` installs it), and Docker with Compose. `init` checks for each of them first, and prints how to install anything missing on your operating system.

```sh
git clone https://github.com/RbMo7/dispatch.git
cd dispatch
pnpm install
```

## 1. Run init

```sh
pnpm dispatch init
```

`init` asks:

1. Which chains to enable.
2. The network for each: devnet or Base Sepolia by default. Mainnet needs you to type `yes, mainnet`.
3. Each chain's RPC URL. The default is the network's public RPC, which rate-limits.
4. How each Sender signs: a new local encrypted key, an existing Privy wallet, an existing AWS KMS key, or the committed development keyfile.
5. Whether each Sender is a plain wallet, a Squads multisig or a Safe.
6. The database: Compose's Postgres by default, or a `postgres://` URL.

A new local key is made by the Signer's own `keys new` command. Its passphrase is read from the terminal without echo, and never written to a file. `init` never creates cloud resources or multisigs. A Privy or AWS KMS key, a Squads multisig and a Safe must exist first.

To answer every question with a flag instead, as in a script, pass `--yes`. The passphrase then comes from `SIGNER_KEYSTORE_PASSPHRASE`. This run sets up Solana devnet with a new local key and does not start anything:

```sh
read -rs SIGNER_KEYSTORE_PASSPHRASE && export SIGNER_KEYSTORE_PASSPHRASE
pnpm dispatch init --yes --chains solana --solana-signer local --no-start
```

```text
Dispatch setup
Using the keystore passphrase in SIGNER_KEYSTORE_PASSPHRASE.
- Creating the Solana key "solana-sender"...
  Created the Solana key "solana-sender": BsUyBiprX3qwgDWV4pxrNEUL8m1eodBtYUbpYGiV9Exn
- Wrote signer/local/signer.config.json (mode 0600)
- Wrote .env (mode 0600)
Generated AUTH_TOKEN, OPERATOR_TOKEN and SIGNER_AUTH_TOKEN into .env. They are not shown here; read them from the file.

Before you rely on it
  Each key has a default policy (its chain and, for a multisig, its pin). Tighten it:
    docs/self-hosting/signer.md#4-write-a-policy-for-every-address

Start the services later with
  read -rs SIGNER_KEYSTORE_PASSPHRASE && export SIGNER_KEYSTORE_PASSPHRASE
  docker compose up -d --build postgres signer
  pnpm db:migrate
  docker compose up -d --build api worker
```

`pnpm dispatch init --help` lists every flag.

`init` writes two files, each mode 0600, and backs up the old one first:

- `signer/local/signer.config.json`, the Signer's config. Each key gets a default policy: its chain, and for a Multisig Sender its pin. Tighten it before real funds, as [Write a policy for every address](./signer.md#4-write-a-policy-for-every-address) describes.
- `.env`, the engine's settings. `init` changes only the lines it sets and keeps every other line. It generates `AUTH_TOKEN`, `OPERATOR_TOKEN` and `SIGNER_AUTH_TOKEN`, and never prints them.

## 2. Start the services

If you answer yes to "Start all services now?", `init` starts Postgres and the Signer with Docker Compose, applies the migrations, starts the API and the worker, and waits for each. With `--no-start`, run the commands it printed. Compose's Signer reads the keystore passphrase from the shell that runs `docker compose`, so export it in that shell.

The API's image includes the web console, so the API also serves `/console` and `/docs`.

## 3. Fund each address

`init` ends by listing each address to fund, with a faucet on test networks:

```text
Fund these addresses
  Solana BsUyBiprX3qwgDWV4pxrNEUL8m1eodBtYUbpYGiV9Exn
    pays payments and fees (SOL); faucet: https://faucet.solana.com
```

Send the native asset, and any token you pay in. For a Multisig Sender, fund the multisig with what it pays and the engine's key with fees.

## 4. Run doctor

`init` runs `doctor` as its last step. Run it again after each fix:

```sh
pnpm dispatch doctor
```

On a funded Solana devnet engine, with the Signer, the API and the worker running, it prints:

```text
Configuration
  ✓ PASS  Environment parses          every setting parsed
  ✓ PASS  Tokens                      AUTH_TOKEN and OPERATOR_TOKEN are distinct and at least 32 characters
  ✓ PASS  Enabled chains              solana sends from 33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf

Database
  ✓ PASS  Reachable                   answered at localhost:5433/dispatch_docs_followups
  ✓ PASS  Migrated                    every migration is applied

Chain
  ✓ PASS  RPC reachable (Solana)      SOLANA_RPC_URL (solana-devnet.g.alchemy.com) answered
  ✓ PASS  Network (Solana)            SOLANA_RPC_URL serves devnet

Signer
  ✓ PASS  Reachable                   the Signer at SIGNER_URL (localhost:8492) answered and accepted SIGNER_AUTH_TOKEN
  ✓ PASS  Key held (Solana)           the Signer holds the ed25519 key for 33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf
  ✓ PASS  Not reachable from the API  neither SIGNER_URL nor SIGNER_AUTH_TOKEN is set in Compose's api service

Sender
  ✓ PASS  Fee balance (Solana)        33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf holds 8.997176623 SOL, which covers the 0.00002 SOL in fees over 4 transactions in the last 24 hours
  ! WARN  Token balances (Solana)     33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf holds no USDC, so a payment in it fails its Funding Check
          fix: Send USDC to 33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf

Console
  ! WARN  Built                       web/dist/engine is missing, so the API serves no console
          fix: run pnpm --dir web install && pnpm --dir web build

11 passed, 2 warnings, 0 problems
```

Each line is a check, its status and what it found. Under each warning and failure is the fix. `doctor` exits `0` when no check failed, `1` when one did, and `2` when it could not run, so a deploy can stop on a broken setup. [Setup checks](./doctor.md) lists every check, why it matters and how to fix it. The console's **Setup** page shows the same checks as the worker last ran them.

## Change the setup later

Run `pnpm dispatch init` again to change one chain or add another. It shows the current setup, changes only what you pick, and keeps every token that passes `doctor`.

To pay from more than one Sender on a chain, such as a hot wallet beside a multisig, add a named Sender. `init` can do it: `--solana-sender-name` or `--base-sender-name` adds a Sender beside the ones the chain has, in the senders file (`SENDERS_FILE`, default `senders.json`), and `--solana-default` or `--base-default` names the one that pays when a request names none. `pnpm dispatch init --help` lists them. You can also write the senders file yourself. [Send from more than one Sender](../guides/multiple-senders.md) shows how.

## Run without init

You can write the configuration yourself instead. Copy `.env.example` to `.env` and set `AUTH_TOKEN`, `OPERATOR_TOKEN`, `ENABLED_CHAINS`, and each enabled chain's RPC URL and Sender address. [Configuration](./configuration.md) lists every variable, and [Set up a Signer](./signer.md) writes the Signer's config.

### With Docker Compose

```sh
docker compose up -d postgres && pnpm db:migrate
docker compose up
```

Migrations run from the host. Compose builds one image for the API and the worker and another for the Signer, and starts four services:

| Service | Port | What Compose sets |
| --- | --- | --- |
| `postgres` | 5432 | Postgres 16, with the user, password and database all named `dispatch` |
| `api` | 8420 | `DATABASE_URL`, and empty `SIGNER_URL` and `SIGNER_AUTH_TOKEN`: the API never calls the Signer |
| `worker` | none | `DATABASE_URL`, `SIGNER_URL=http://signer:8421`, and the shared Signer token |
| `signer` | 8421 | The config `init` wrote, or else the committed development keys, and the shared Signer token |

Compose passes `.env` to the API and the worker, and wires the database and Signer addresses itself. Without `SIGNER_CONFIG` in `.env`, the Signer uses the committed development keys in `signer/keys.dev.json`. They are for development only. Replace them in any real deployment.

### From source

You need a Postgres 16.

```sh
docker compose up -d postgres
pnpm db:migrate
pnpm --dir signer install
SIGNER_AUTH_TOKEN=dev-only-signer-token pnpm --dir signer dev
```

`pnpm --dir signer dev` starts the Signer with the development keys. Set the same `SIGNER_AUTH_TOKEN` in `.env`, then start the API and the worker, each in its own terminal:

```sh
pnpm dev:api
pnpm dev:worker
```

`pnpm dev:api` and `pnpm dev:worker` reload on every change. For a deployment, build once with `pnpm build` and run `pnpm start:api` and `pnpm start:worker`. The [Quickstart](../quickstart.md) walks through a run from source with your own key.

To serve the console and these docs from source, build the web app once from the repository root, then restart the API:

```sh
pnpm --dir web install
pnpm --dir web build
```

The API then serves the console at `/console`, the docs at `/docs`, and redirects `/` to `/console`. Without a build, it serves only the API.

## Check that it runs

```sh
curl -s "$DISPATCH_URL/health"
```

```json
{ "status": "ok" }
```

`GET /health` answers while the API process runs. It does not check the database, the worker, the Signer or any RPC. `pnpm dispatch doctor` checks those, and the worker logs `worker started` with the chains and Senders it serves.

## Where things run in production

- Run the API and the worker against the same `DATABASE_URL`. The API stores Dispatches and the worker claims them from the same tables.
- Run one worker per engine. The worker owns each Sender's nonce and its pending transactions.
- Run one engine per Sender. Never point two engines at the same Sender key, and never send from a Sender's address with anything else, such as a wallet app or a script, while the engine runs. Two senders that share a key use the same Base nonces, and each fails the other's transactions with `NONCE_ALREADY_USED`. To split work, such as payroll and refunds, give one engine several [named Senders](../guides/multiple-senders.md), each with its own key.
- Put the Signer on a private network that only the worker can reach. The API needs no Signer settings. [Set up a Signer](./signer.md#6-place-the-signer-on-a-private-network) has the details.
- Serve the API, the console and the docs over TLS, through a proxy in front of port 8420.
- Run `pnpm dispatch doctor` in your deploy, and stop when it exits `1`.
- Run a separate engine, with its own database, Signer and keys, for each network: one for testnet and one for mainnet.
