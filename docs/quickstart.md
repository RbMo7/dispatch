# Quickstart

In this guide you run the engine on your machine and send one payment on a test network: 0.0001 ETH on Base Sepolia, or 0.01 SOL on Solana devnet. You finish with a Dispatch whose status is `confirmed` and a transaction you can open in a block explorer. Allow about 20 minutes, most of it waiting for a faucet.

Every command below was run as written. Where an example shows an address, a hash or an id, yours will differ.

## Before you start

You need:

- Node.js 22 or later, and pnpm 10 (`corepack enable` installs it).
- Docker, to run Postgres. Any Postgres 16 works if you already have one.
- `git`, `curl` and `openssl`.

Pick one chain for this guide. The code blocks have a tab for each, and choosing a tab chooses it everywhere on the page.

## 1. Get the code

```sh
git clone https://github.com/RbMo7/dispatch.git
cd dispatch
pnpm install
pnpm --dir signer install
```

## 2. Start Postgres and create the tables

```sh
docker compose up -d postgres
pnpm db:migrate
```

Compose starts Postgres 16 on port 5432 with the user, password and database all named `dispatch`. `pnpm db:migrate` creates the tables. It ends with `migrations applied successfully!`.

## 3. Create a key for your Sender

The Sender is the wallet the engine pays from. Its key lives in the Signer, never in the engine. For this guide, keep it in the Signer's `local` backend: an encrypted file on your machine.

Make a folder for the key and a passphrase to encrypt it with:

```sh
mkdir -p "$HOME/.dispatch"
chmod 700 "$HOME/.dispatch"
openssl rand -hex 32 > "$HOME/.dispatch/keystore-passphrase"
chmod 600 "$HOME/.dispatch/keystore-passphrase"
export SIGNER_KEYSTORE_DIR="$HOME/.dispatch/keystore"
export SIGNER_KEYSTORE_PASSPHRASE_FILE="$HOME/.dispatch/keystore-passphrase"
```

Create the key. The command prints the new address and nothing secret:

```sh title="Base"
pnpm --dir signer signer keys new --curve secp256k1 --name base-sender
```

```sh title="Solana"
pnpm --dir signer signer keys new --curve ed25519 --name solana-sender
```

The last line of the output is the address:

```text title="Base"
0x1Dd9661FAb2d82731E033c21C46BA009633bf558
```

```text title="Solana"
6vojQiQfhxJuiW5LDG2U8NvmG6G97MKXqvkQkJhYHKm2
```

Keep the passphrase file. Without it the key cannot be decrypted, and nothing can recover it.

## 4. Fund the Sender

The Sender pays the payment and the network fee, so it needs test funds.

- **Base Sepolia.** Send at least 0.001 test ETH to your address from a Base Sepolia faucet. Coinbase's developer platform runs one, and Base's documentation lists others.
- **Solana devnet.** Request 1 SOL for your address at [faucet.solana.com](https://faucet.solana.com), with the network set to devnet.

Check that the funds arrived. Replace the address with yours:

```sh title="Base"
curl -s https://sepolia.base.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x1Dd9661FAb2d82731E033c21C46BA009633bf558","latest"]}'
```

```sh title="Solana"
curl -s https://api.devnet.solana.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["6vojQiQfhxJuiW5LDG2U8NvmG6G97MKXqvkQkJhYHKm2"]}'
```

The balance is in wei (hexadecimal) on Base and in lamports on Solana. Anything above zero is enough to continue:

```json title="Base"
{"jsonrpc":"2.0","id":1,"result":"0x676b3a7ff14f7"}
```

```json title="Solana"
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"4.4.0-beta.1","slot":517229875},"value":187495000},"id":1}
```

## 5. Start the Signer

The Signer reads a JSON file that maps each address to its key. Write one for your key, using your own address:

```sh title="Base"
cat > "$HOME/.dispatch/signer.json" <<'EOF'
{
  "0x1Dd9661FAb2d82731E033c21C46BA009633bf558": {
    "curve": "secp256k1",
    "backend": "local",
    "keyRef": "base-sender"
  }
}
EOF
```

```sh title="Solana"
cat > "$HOME/.dispatch/signer.json" <<'EOF'
{
  "6vojQiQfhxJuiW5LDG2U8NvmG6G97MKXqvkQkJhYHKm2": {
    "curve": "ed25519",
    "backend": "local",
    "keyRef": "solana-sender"
  }
}
EOF
```

The engine and the Signer share a bearer token, so nothing else on your network can ask for a signature. Generate one, and note it, because the engine needs the same value in step 6:

```sh
export SIGNER_AUTH_TOKEN=$(openssl rand -hex 32)
echo "$SIGNER_AUTH_TOKEN"
```

Start the Signer in the same terminal, so it sees the keystore variables from step 3, and leave it running:

```sh
SIGNER_CONFIG="$HOME/.dispatch/signer.json" pnpm --dir signer exec tsx src/index.ts
```

It decrypts the key, checks that the key's address matches the config, and starts listening:

```text
NOTICE: the local backend decrypts keys from /Users/you/.dispatch/keystore into this process's memory. Anyone who can read the host or the process can read them; prefer aws-kms or privy where you can.
signer listening on :8421
```

If it prints `signer refused to start:` instead, the line after it says what is wrong. [Read the startup checks](./signer.md#read-the-startup-checks) lists every message.

## 6. Configure the engine

Open a second terminal in the `dispatch` folder. Copy the example settings:

```sh
cp .env.example .env
```

Edit `.env` and set these lines. Use your own Sender address, the Signer token from step 5, and a new random API token (`openssl rand -hex 32`):

```dotenv title="Base"
ENABLED_CHAINS=base
BASE_SENDER_ADDRESS=0x1Dd9661FAb2d82731E033c21C46BA009633bf558
SIGNER_AUTH_TOKEN=<the token from step 5>
AUTH_TOKEN=<a new random token>
```

```dotenv title="Solana"
ENABLED_CHAINS=solana
SOLANA_SENDER_ADDRESS=6vojQiQfhxJuiW5LDG2U8NvmG6G97MKXqvkQkJhYHKm2
SIGNER_AUTH_TOKEN=<the token from step 5>
AUTH_TOKEN=<a new random token>
```

The rest of `.env.example` already points at Base Sepolia (`BASE_RPC_URL=https://sepolia.base.org`, `BASE_CHAIN_ID=84532`) and Solana devnet (`SOLANA_RPC_URL=https://api.devnet.solana.com`). Public endpoints rate-limit, so for anything beyond this guide use your own RPC provider. [Configuration](./operations/configuration.md) explains every setting.

## 7. Start the API and the worker

Run each in its own terminal, from the `dispatch` folder:

```sh
pnpm dev:api
```

```sh
pnpm dev:worker
```

The worker logs `worker started` with the chains it serves. Check the API from a fourth terminal. Set two variables first, because every example in these docs uses them:

```sh
export DISPATCH_URL=http://localhost:8420
export DISPATCH_TOKEN=<your AUTH_TOKEN>
curl -s "$DISPATCH_URL/health"
```

```json
{ "status": "ok" }
```

## 8. Send a payment

```sh title="Base"
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: quickstart-base-001" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "base",
    "items": [
      {
        "type": "payment",
        "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
        "asset": "ETH",
        "amount": "100000000000000"
      }
    ]
  }'
```

```sh title="Solana"
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: quickstart-solana-001" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "solana",
    "items": [
      {
        "type": "payment",
        "recipient": "HUJCp4QWFAtmTa6oEk4gXw5r2fuCah4FHn8c12QBv9KB",
        "asset": "SOL",
        "amount": "10000000"
      }
    ]
  }'
```

The engine stores the Dispatch and answers right away with its id:

```json
{ "dispatchId": "cfd579de-2909-4ee5-ba4c-64e08db93040", "status": "queued" }
```

`amount` is in the asset's smallest unit: 100000000000000 wei is 0.0001 ETH, and 10000000 lamports is 0.01 SOL. [Your first Dispatch, line by line](./first-dispatch.md) explains each field.

## 9. Poll until it is confirmed

Save the id from the response and ask for the Dispatch:

```sh
export DISPATCH_ID=cfd579de-2909-4ee5-ba4c-64e08db93040
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

Within a few seconds the worker claims it and sends the transaction. The item is then `broadcasting`. Ask again after a few more seconds:

```json title="Base"
{
  "dispatchId": "cfd579de-2909-4ee5-ba4c-64e08db93040",
  "mode": "managed",
  "status": "confirmed",
  "items": [
    {
      "type": "payment",
      "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "asset": "ETH",
      "decimals": 18,
      "amount": "100000000000000",
      "status": "confirmed",
      "transactionHash": "0xc45a587722caedff3ceb01804d121eb746463f30a79f13fe42d79fd8264c5bb3",
      "error": null
    }
  ]
}
```

```json title="Solana"
{
  "dispatchId": "f047a17d-4058-44c6-bd81-42c3f831963a",
  "mode": "managed",
  "status": "confirmed",
  "items": [
    {
      "type": "payment",
      "recipient": "HUJCp4QWFAtmTa6oEk4gXw5r2fuCah4FHn8c12QBv9KB",
      "asset": "SOL",
      "decimals": 9,
      "amount": "10000000",
      "status": "confirmed",
      "transactionHash": "324MMGSjRpbz9XmpnP5zCZVP9UfHRY1gpEDxeakkV5SSTGCkVFs1A17ioQBgbegHM3s2m7hCFqxvEWoZx1RiYQ9R",
      "error": null
    }
  ]
}
```

In our run the Base payment confirmed 12 seconds after it was submitted, and the Solana one 14 seconds after.

Open the transaction in an explorer to see it on chain:

- Base Sepolia: `https://sepolia.basescan.org/tx/<transactionHash>`
- Solana devnet: `https://explorer.solana.com/tx/<transactionHash>?cluster=devnet`

## If it does not confirm

- **The item is `failed` with `INSUFFICIENT_FUNDS`.** The Sender cannot pay. `chainDetail.short` is how much more it needs, in the smallest unit. Fund it, then send the payment again with a new `Idempotency-Key`.
- **The item is `failed` with `SIGNER_UNREACHABLE`.** The worker could not get a signature. Check that the Signer is running and that `SIGNER_AUTH_TOKEN` is the same in both places.
- **The status stays `queued`.** The worker is not running, or it does not serve this chain. Check `ENABLED_CHAINS` and the worker's log.
- **The API answers `400` with `CHAIN_NOT_ENABLED`.** The `chain` in your request is not in `ENABLED_CHAINS`.

[Troubleshooting](./operations/troubleshooting.md) covers the rest.

## Next

- [Your first Dispatch, line by line](./first-dispatch.md)
- [Set up a production Signer](./signer.md) before you hold real funds
- [The HTTP API](./api.md)
