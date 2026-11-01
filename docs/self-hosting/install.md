# Install and run

Dispatch is three processes sharing one Postgres database: the **API** (`src/index.ts`, port 8420), the **worker** that sends and tracks transactions (`src/worker.ts`), and the **Signer** that holds the Senders' keys (`signer/`, port 8421). You can run all of them with Docker Compose, or each from source.

Both ways start with the code:

```sh
git clone https://github.com/RbMo7/dispatch.git
cd dispatch
cp .env.example .env
```

Edit `.env`: set `AUTH_TOKEN`, `ENABLED_CHAINS`, and each enabled chain's RPC URL and Sender address. [Configuration](./configuration.md) lists every variable.

## Run with Docker Compose

```sh
docker compose up -d postgres && pnpm install && pnpm db:migrate
docker compose up
```

Migrations run from the host, so the first line needs Node.js 22 and pnpm. Compose then builds one image for the API and the worker and another for the Signer, and starts all four services:

| Service | Port | What Compose sets |
| --- | --- | --- |
| `postgres` | 5432 | Postgres 16, with the user, password and database all named `dispatch` |
| `api` | 8420 | `DATABASE_URL`, and empty `SIGNER_URL` and `SIGNER_AUTH_TOKEN`: the API never calls the Signer |
| `worker` | none | `DATABASE_URL`, `SIGNER_URL=http://signer:8421`, and the shared Signer token |
| `signer` | 8421 | The committed development keys and a development token |

Compose passes `.env` to the API and the worker, and wires the database and Signer addresses itself. The API's image includes the built web console, so it serves `/console` and `/docs` too.

The Compose Signer is for development only. It uses the `keyfile` backend with the committed keys in `signer/keys.dev.json` and `signer/signer.config.dev.json`, and the token `dev-only-signer-token`. Replace the keys, the config and the token in any real deployment, as [Set up a Signer](./signer.md) describes.

## Run from source

You need Node.js 22 or later, pnpm 10 (`corepack enable` installs it), and a Postgres 16.

```sh
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm --dir signer install
SIGNER_AUTH_TOKEN=dev-only-signer-token pnpm --dir signer dev
```

`pnpm --dir signer dev` starts the Signer with the development keys. Set the same `SIGNER_AUTH_TOKEN` in `.env`, then start the API and the worker, each in its own terminal:

```sh
pnpm dev:api
pnpm dev:worker
```

`pnpm dev:api` and `pnpm dev:worker` reload on every change. For a deployment, build once with `pnpm build` and run `pnpm start:api` and `pnpm start:worker`. The [Quickstart](../quickstart.md) walks through a run from source with your own key in place of the development keys.

## Build the console and these docs

The API serves the web console and these docs when the web build exists. Build it once from the repository root:

```sh
pnpm --dir web install
pnpm --dir web build
```

Restart the API. It then serves the console at `/console`, the docs at `/docs`, and redirects `/` to `/console`. Without a build, the API serves only the API. The Docker image builds the console in for you.

## Check that it runs

```sh
curl -s "$DISPATCH_URL/health"
```

```json
{ "status": "ok" }
```

The worker logs `worker started` with the chains it serves. `GET /health` answers while the API process runs. It does not check the database, the worker, the Signer or any RPC, so watch the worker's log too.

## Where things run in production

- Run the API and the worker against the same `DATABASE_URL`. The API stores Dispatches and the worker claims them from the same tables.
- Run one worker per engine. The worker owns each Sender's nonce, and nothing else may send from a Sender while the engine runs.
- Put the Signer on a private network that only the worker can reach. The API needs no Signer settings. [Set up a Signer](./signer.md#6-place-the-signer-on-a-private-network) has the details.
- Serve the API, the console and the docs over TLS, through a proxy in front of port 8420.
- Run a separate engine, with its own database, Signer and keys, for each network: one for testnet and one for mainnet.
