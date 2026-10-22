# How to run a production Signer

This runbook takes you from nothing to a Signer that holds your Senders' keys in Privy or AWS KMS, enforces a policy on every transaction, and serves the engine over a private network. It ends with the checklist to clear before mainnet.

Work through it in order. [`signer/README.md`](../signer/README.md) is the reference it links to: every environment variable, the config file's shape, the exact meaning of each policy rule, and how each backend signs.

## What the Signer is

The Signer is a separate process that holds each Sender's key and answers `POST /sign` (ADR-0002, ADR-0046), plus one read-only route, `GET /keys/{address}/policy` ([below](#reading-a-keys-pins)). The engine's worker sends it the whole unsigned transaction with `Authorization: Bearer <SIGNER_AUTH_TOKEN>`. The Signer checks the token, decodes the transaction, checks it against the Sender's policy, signs it, and writes one audit line. The engine never holds a key, and it checks every signature it gets back against the Sender's address before using it.

Only the worker signs. The API process never calls the Signer.

### Signing a Safe transaction

A second request kind, for a deployment whose Sender is a Safe (ADR-0051, ADR-0052), asks the Signer to sign a Safe transaction instead of a chain transaction. Nothing else about `POST /sign` changes: a request without `kind` is the ordinary one above, and any other `kind` is `400`. The engine sends it only in Safe mode.

```json
{
  "kind": "safeTransaction",
  "chain": "base",
  "curve": "secp256k1",
  "address": "0xTheSigningKey…",
  "safeTransaction": {
    "safe": "0xTheSafe…",
    "chainId": 8453,
    "to": "0x…",
    "value": "0",
    "data": "0x…",
    "operation": 1,
    "safeTxGas": "0",
    "baseGas": "0",
    "gasPrice": "0",
    "gasToken": "0x0000000000000000000000000000000000000000",
    "refundReceiver": "0x0000000000000000000000000000000000000000",
    "nonce": "7"
  }
}
```

`address` is the signing key, never the Safe. Every number but `chainId` and `operation` (0 is a call, 1 a delegatecall) is a decimal string, and every field is required. A missing or malformed field is `400`.

The Signer computes the EIP-712 hash of those fields itself, with the domain `{ chainId, verifyingContract: safe }` and Safe's `SafeTx` struct, and signs that 32-byte hash with the key's backend, so `keyfile`, `local`, `privy` and `aws-kms` all work. The response is the usual `{ "signature": "<base64>" }`, but `v` is 27 or 28, not the 0 or 1 a transaction signature ends in, because the Safe Transaction Service rejects the latter. The engine recomputes the hash and refuses a signature that does not recover to the key's address.

A key with no policy signs this kind, for any caller with the bearer token. A key with a policy refuses it with `403 { "error", "reason" }` unless the policy pins the Safe with `allowedSafe` and the transaction passes its checks (a delegatecall to MultiSendCallOnly, zero gas and refund fields; see [section 4](#4-write-a-policy-for-every-address)). The audit line adds `kind`, `safe` and `safeNonce`, and its `transactionId` is the Safe transaction hash. It never records the call data.

## 1. Choose a backend for each address

Each address in the Signer's config names its own backend, and one Signer can mix them.

| Backend | Use it for | Base (`secp256k1`) | Solana (`ed25519`) |
| --- | --- | --- | --- |
| `keyfile` | Development only. Never mainnet. The private key sits in a file and in process memory. | yes | yes |
| `aws-kms` | Production, the strongest option. Keys live in AWS KMS and never reach the host. | key spec `ECC_SECG_P256K1` | key spec `ECC_NIST_EDWARDS25519` |
| `privy` | Production. Keys live in Privy server wallets and never reach the host. | an Ethereum wallet | a Solana wallet |
| `local` | Production when you have neither of the above. Keys are encrypted files, decrypted into the Signer's process memory. The weakest production option. | yes | yes |

Rank them `aws-kms`, then `privy`, then `local`. With `local`, a compromise of the Signer's host exposes the key, so rely on a tight [policy](#4-write-a-policy-for-every-address) and keep little in the Sender.

The Privy backend has been run against real Privy on Base Sepolia and Solana devnet (`RUN_PRIVY=1`). The AWS KMS backend has been tested only against mocks. Its live test has not yet been run against a real key (#61). The [mainnet checklist](#mainnet-checklist) says what to do about that.

## 2. Set up the keys

Follow the section for each backend you chose.

### Privy

1. In the [Privy Dashboard](https://dashboard.privy.io), create an app, or open an existing one. Copy its app ID and app secret. These become `PRIVY_APP_ID` and `PRIVY_APP_SECRET`.
2. Create an authorization key. Go to the app's **Wallets** section, open **Authorization keys**, and click **New key**. Save the private key somewhere secret right away, because Privy does not keep it. This private key becomes `PRIVY_AUTHORIZATION_KEY`, exactly as Privy shows it.
3. Create one server wallet per Sender, owned by that authorization key. Use `"chain_type": "ethereum"` for a Base Sender and `"chain_type": "solana"` for a Solana Sender:

   ```sh
   curl -X POST https://api.privy.io/v1/wallets \
     -u "<privy-app-id>:<privy-app-secret>" \
     -H "privy-app-id: <privy-app-id>" \
     -H "Content-Type: application/json" \
     -d '{ "chain_type": "ethereum", "owner": { "public_key": "<authorization-key-public-key>" } }'
   ```

   The response's `id` is the wallet ID, which is the `keyRef` in the Signer's config. Its `address` is the Sender's address. Instead of `owner`, you can pass `"owner_id"` with a key quorum that holds the authorization key.

4. Check that every wallet has an owner. `GET https://api.privy.io/v1/wallets/<wallet-id>`, with the same two credentials, returns the wallet with its `owner_id`, which must not be empty. To give an existing wallet an owner, set it in the Privy Dashboard.

The owner is what protects the wallet. Without one, Privy signs for anyone holding the app secret. With one, Privy refuses any signing request that the authorization key has not signed, so a leaked app secret alone can't move funds. The Signer signs every request with `PRIVY_AUTHORIZATION_KEY` when it is set.

Generate a fresh authorization key for mainnet. Never paste it into chat, a ticket, or a commit.

### AWS KMS

1. Create one asymmetric signing key per Sender, with the key spec its chain needs:

   ```sh
   aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY --description "dispatch Base sender"
   aws kms create-key --key-spec ECC_NIST_EDWARDS25519 --key-usage SIGN_VERIFY --description "dispatch Solana sender"
   ```

   Each prints `KeyMetadata`, whose `Arn` is the key's `keyRef`. The key ID or an alias ARN works too. To add an alias, run `aws kms create-alias --alias-name alias/<name> --target-key-id <key-id>`.

2. Give the Signer's credentials exactly two actions, on those keys alone:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["kms:GetPublicKey", "kms:Sign"],
         "Resource": [
           "arn:aws:kms:<region>:<account-id>:key/<base-key-id>",
           "arn:aws:kms:<region>:<account-id>:key/<solana-key-id>"
         ]
       }
     ]
   }
   ```

   Attach it to the role the Signer runs under, such as an ECS task role or an EC2 instance role. The Signer has no AWS variables of its own. The AWS SDK finds the region and credentials through its standard provider chain. Set `AWS_REGION`, and prefer a role to long-lived `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

3. Find each key's address. The address comes from the key's public key, and the Signer derives it at startup. Configure the key under a placeholder address, as in [Write the config file](#3-write-the-config-file), and start the Signer. It refuses to start and prints the address it derived:

   ```
   signer refused to start: these addresses don't match their keys:
     0x0000000000000000000000000000000000000000: expected 0x0000000000000000000000000000000000000000, derived 0xYourBaseSender…
   ```

   Replace the placeholder with the derived address. A Solana key works the same way under any placeholder.

### Local

Each key is one encrypted file in a directory. scrypt turns your passphrase into the encryption key, and AES-256-GCM encrypts the private key. The Signer decrypts every key it is configured for when it starts, and keeps them in memory (ADR-0050).

1. Choose a keystore directory and a passphrase. Put the passphrase in a file only the Signer's user can read, such as a mounted secret. Use a long random one, for example `openssl rand -hex 32`.

   ```sh
   export SIGNER_KEYSTORE_DIR=/var/lib/signer/keystore
   export SIGNER_KEYSTORE_PASSPHRASE_FILE=/run/secrets/keystore-passphrase
   ```

   `SIGNER_KEYSTORE_PASSPHRASE` works too. The passphrase is never a command-line argument.

2. Create a key with the CLI, run from the `signer/` package (`pnpm signer keys ...`), or `node dist/cli.js keys ...` inside the image. It prints the key's address and nothing secret:

   ```sh
   pnpm signer keys new --curve secp256k1 --name base-sender
   pnpm signer keys new --curve ed25519 --name solana-sender
   ```

   To bring an existing key, pipe it in on stdin as 64 hex characters (32 bytes). Reading it with `read -rs` keeps it out of your shell history and the process list:

   ```sh
   read -rs KEY && printf %s "$KEY" | pnpm signer keys import --curve secp256k1 --name base-sender; unset KEY
   ```

   `pnpm signer keys list` shows each key's name, curve and address, and `pnpm signer keys export-public --name <name>` prints one address. Neither needs the passphrase. The CLI has no command that prints or exports a private key, and it never overwrites a key.

3. Use the address it printed in the config file, with `"backend": "local"` and the key's name as `keyRef`. See [Write the config file](#3-write-the-config-file).

The directory is created `0700` and each file `0600`. The Signer logs a warning if the directory is open to other users.

Back up the passphrase and the key files, separately and somewhere safe. **If you lose the passphrase, the keys are lost.** The CLI cannot recover them, and it cannot change a passphrase. If you want to move funds off a key, do it before you lose access.

## 3. Write the config file

The config file is JSON. `SIGNER_CONFIG` holds its path. It maps each Sender's address to its `curve`, `backend`, `keyRef`, and an optional `policy`. [`signer/README.md`](../signer/README.md#configuration) has the full shape.

This example signs for a Base Sender in Privy and a Solana Sender in AWS KMS, each with a policy:

```json
{
  "0xYourBaseSender…": {
    "curve": "secp256k1",
    "backend": "privy",
    "keyRef": "<privy-wallet-id>",
    "policy": {
      "chainIds": [8453],
      "allowedDestinations": [
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "0xYourRecipient…"
      ],
      "maxNativePerTransaction": "10000000000000000",
      "maxTokenPerTransaction": {
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": "500000000"
      }
    }
  },
  "YourSolanaSender…": {
    "curve": "ed25519",
    "backend": "aws-kms",
    "keyRef": "arn:aws:kms:<region>:<account-id>:key/<solana-key-id>",
    "policy": {
      "allowedDestinations": [],
      "maxNativePerTransaction": "1000000000",
      "maxTokenPerTransaction": {
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "500000000"
      }
    }
  }
}
```

The Base Sender may sign only on Base mainnet (chain ID 8453), only to USDC's contract and one recipient, with up to 0.01 ETH and 500 USDC per transaction. The Solana Sender may use no program beyond the ones every payment uses, with up to 1 SOL and 500 USDC per transaction. Amounts are decimal strings in base units, meaning wei, lamports, or the token's smallest unit.

## 4. Write a policy for every address

A policy is optional, but an address without one is signed for unconditionally, for anyone holding the bearer token. Give every production address a policy. [`signer/README.md`](../signer/README.md#rules) defines each rule exactly.

- `chainIds` (Base only). The chain IDs the key may sign for. Use `[8453]` for Base mainnet.
- `allowedDestinations`. On Base, every contract or address a transaction calls. On Solana, every program it uses, besides System, Token, Token-2022, Associated Token, and ComputeBudget.
- `maxNativePerTransaction`. The most ETH or SOL one transaction may move.
- `maxTokenPerTransaction`. The most of each listed token one transaction may move, keyed by token contract (Base) or mint (Solana).
- `allowedSafe` (Base only, needs `chainIds`). Pins the key to one Safe: it signs only that Safe's `execTransaction` and the matching `safeTransaction` typed data, and only as a delegatecall to MultiSendCallOnly with zero gas and refund fields. `allowedMultiSend` overrides the MultiSendCallOnly addresses (the defaults are Safe 1.4.1 and 1.3.0). Use it for a Safe's executor and delegate keys. The nested payments are not decoded; the owners' confirmation is the control.
- `allowedMultisig` (Solana only). Pins the key to one Squads multisig: it signs only that multisig's `vaultTransactionCreate`, `proposalCreate`, `vaultTransactionExecute` and `vaultTransactionAccountsClose`, plus the ComputeBudget instructions that accompany them, with itself as fee payer. It refuses votes (approve, reject, cancel), config transactions and every other program. The nested payments are not decoded; the Approvers' vote is the control. If you also set `allowedDestinations`, list the Squads program in it.

A misspelled rule, a bad address, or a bad amount stops the Signer at startup. Before you write a policy, know where it can surprise you:

- **A token Payment on Base goes to the token contract.** List the token contract in `allowedDestinations`. Listing the recipient is not enough, because the transaction's `to` is the contract.
- **A Bulk Call needs its aggregator and every item's target listed.** On Base, the aggregator contract and each call inside it must be in `allowedDestinations`.
- **Bulk Call ERC-20 items count against the Sender's token cap.** They spend the aggregator's balance, not the Sender's, but the Signer sums every ERC-20 `transfer` in the transaction.
- **Caps apply per transaction, so they cap a whole bundle.** The engine bundles several Payments into one transaction (one Bulk Call chunk on Base, up to a full message on Solana). A bundle whose total is over the cap is refused, even when each Payment is under it.
- **Nothing limits totals across transactions.** There is no daily cap. A compromised engine can still send many transactions that are each within the policy. Keep only what you need in each Sender.
- **On Solana, `allowedDestinations` doesn't restrict recipients.** It lists programs. Cap the amounts to limit how much leaves.
- **What the Signer can't read, it refuses.** With a policy set, it refuses bytes it can't decode, such as an unknown transaction type or malformed calldata. It also refuses any call to a capped token that it can't count, such as `approve`. The refusal names what it couldn't read.
- **An allowed contract is trusted with whatever it does next.** The Signer reads the transaction's own call and every call inside `aggregate3Value`. Whatever a listed contract does after that, the policy never sees. List only contracts you trust that far.

### Keys for a Multisig Sender

A Multisig Sender (Squads on Solana, Safe on Base) needs one more key behind the Signer: the engine's own, which proposes and executes but can never approve. It is an ordinary key on any backend, with a policy that pins it to one multisig with `allowedMultisig` or one Safe with `allowedSafe`, as above. Setting up the multisig, the key's permissions and the delegate registration is in [`docs/multisig.md`](./multisig.md). The Signer's own startup does not check that the multisig's members or the Safe's owners exclude the key. The engine checks that when it starts.

## 5. Create the bearer token

The engine and the Signer share one token. Generate a long random one:

```sh
openssl rand -hex 32
```

Set it as `SIGNER_AUTH_TOKEN` on the Signer and, unchanged, as `SIGNER_AUTH_TOKEN` on the engine's worker. The Signer refuses to start without a token and answers `401` to a wrong one. Never use Compose's `dev-only-signer-token`, and never reuse a token between environments.

To rotate the token:

1. Stop the worker.
2. Set the new token on the Signer and restart it.
3. Set the new token on the worker and start it.

While the two disagree, every signing request gets `401`, and each Call the worker tries to sign fails with `SIGNER_UNREACHABLE`. Stopping the worker first means no Call fails during the change.

## 6. Place the Signer on a private network

The Signer listens on every interface of its host, on `PORT` (8421 by default), and speaks plain HTTP. It has no TLS. The bearer token crosses the network in clear text, so the link between the worker and the Signer must be a network you trust.

- Make the Signer reachable only from the worker. Put both on a private network, and allow port 8421 only from the worker, for example with a security group that admits only the worker's security group.
- Never publish the Signer's port to the internet, and never put it behind a public load balancer.
- Run one Signer per environment. A testnet engine and a mainnet engine each get their own Signer, config, token, and keys.

TLS and mTLS between the engine and the Signer are not built. ADR-0046 leaves room for mTLS later. A TLS-terminating proxy in front of the Signer, with an `https` `SIGNER_URL`, is untested.

## 7. Run the Signer

Build the image from the repository root:

```sh
docker build -f signer/Dockerfile -t dispatch-signer .
```

Put the secrets in an env file that only the deploy user can read, for example `/etc/dispatch/signer.env`. Include only the variables for the backends your config names:

```sh
SIGNER_AUTH_TOKEN=<token>
PRIVY_APP_ID=<privy-app-id>
PRIVY_APP_SECRET=<privy-app-secret>
PRIVY_AUTHORIZATION_KEY=<privy-authorization-private-key>
AWS_REGION=<region>
```

Run it on the private network the worker uses, with the config mounted read-only and no published port:

```sh
docker network create dispatch-private
docker run -d --name dispatch-signer --restart unless-stopped \
  --network dispatch-private \
  --env-file /etc/dispatch/signer.env \
  -e SIGNER_CONFIG=/config/signer.json \
  -v /etc/dispatch/signer.json:/config/signer.json:ro \
  dispatch-signer
```

The image carries the development keys, but it sets neither `SIGNER_CONFIG` nor `SIGNER_KEYFILE`. A deployment that forgets its own config refuses to start instead of signing with them.

### Read the startup checks

Before it listens, the Signer reads the config, builds each backend it names, and asks each backend for the address behind every `keyRef`. If anything is wrong, it prints `signer refused to start:` and the problem on stderr, then exits with code 1. It reports every bad address at once.

| The message says | What it means |
| --- | --- |
| `SIGNER_CONFIG is required` | `SIGNER_CONFIG` is unset. |
| `SIGNER_CONFIG <path> is unreadable` | The file is missing, or it is not valid JSON. |
| `SIGNER_CONFIG is invalid:` and one line per problem | An entry has a bad `curve`, `backend`, `keyRef`, or `policy`. Each line names the address. |
| `PRIVY_APP_ID is required by the privy backend`, and the like | The config names a backend whose credentials are not set. |
| `SIGNER_KEYSTORE_DIR is required` or `SIGNER_KEYSTORE_PASSPHRASE or SIGNER_KEYSTORE_PASSPHRASE_FILE is required` | The config names the `local` backend and its keystore settings are not set. |
| `the key file did not decrypt: the passphrase is wrong, or the file was altered` | A `local` key. Check the passphrase first, then whether the file changed. |
| `these addresses don't match their keys:` and `expected …, derived …` | The key behind a `keyRef` has a different address. Fix the address or the `keyRef`. |
| `these addresses don't match their keys:` and a backend error | The backend could not produce the key's address. Examples are missing AWS credentials or region, a KMS key with the wrong key spec or usage, and a wrong Privy wallet ID. |
| `SIGNER_AUTH_TOKEN is required` | The token is unset. The Signer checks it after the keys, so this can appear after every key is proven. |

On success it prints `signer listening on :8421` on stderr.

A line starting `WARNING: the keyfile backend holds raw private keys` means some address uses the `keyfile` backend. It must never appear on a mainnet Signer. A line starting `NOTICE: the local backend decrypts keys` means some address uses `local`: the keys are in this process's memory.

## 8. Point the engine at the Signer

Set these on the worker:

- `SIGNER_URL`. The Signer's address on the private network, for example `http://dispatch-signer:8421`.
- `SIGNER_AUTH_TOKEN`. The same token as the Signer's.
- `BASE_SENDER_ADDRESS` and `SOLANA_SENDER_ADDRESS`. The Sender addresses in the Signer's config, one per enabled chain.
- `BASE_CHAIN_ID`. `8453` for Base mainnet. The engine refuses to start if its RPC reports a different chain.

[`.env.example`](../.env.example) documents the rest of the engine's settings. If `SIGNER_AUTH_TOKEN` is unset, the engine still starts, logs a warning, and every signing request gets `401`.

### Reading a key's pins

`GET /keys/{address}/policy`, with the same `Authorization: Bearer <SIGNER_AUTH_TOKEN>`, tells the engine what a key is pinned to (ADR-0055). The engine reads it at startup for a Multisig Sender, so a key with no pin, or pinned to the wrong multisig or Safe, stops the worker before the first Proposal.

```json
{"address":"0xYourExecutor…","curve":"secp256k1","chainIds":[8453],"allowedSafe":"0xyoursafe…"}
```

The answer carries only `address`, `curve`, `chainIds`, `allowedSafe` and `allowedMultisig`, each present only when the policy sets it. Never a key, a key reference, or any other part of the policy (recipients, limits, MultiSend lists). EVM addresses come back lowercase, as the policy stores them. A wrong token is `401`. An address the config doesn't hold is `404 no key for address …`. A Signer from before ADR-0055 answers `404 not found` for the route, and the engine refuses to start against it: upgrade the Signer. This check guards against a misconfigured policy. It does not defend against a compromised Signer, which could report anything. The real control is the Signer refusing at `/sign`.

## 9. Read the audit log

The Signer writes one JSON line per request to stdout, before it answers. Everything else it logs goes to stderr, so stdout carries only the audit log. Ship stdout somewhere durable, such as your log platform or object storage with retention.

```json
{"time":"2026-10-03T09:12:44.512Z","address":"0xYourBaseSender…","chain":"base","transactionId":"0x<transaction-hash>","decision":"signed","status":200}
```

Each line has these fields. A field the request didn't carry is left out.

- `time`. When the Signer answered, in ISO 8601.
- `address` and `chain`. The Sender and chain the request named.
- `transactionId`. Present only when `decision` is `signed`. On Base, the hash of the signed transaction. On Solana, the transaction's signature in base58.
- `kind`, `safe` and `safeNonce`. Only on a request to sign a Safe transaction: `"safeTransaction"`, the Safe's address, and the transaction's nonce. On a `signed` line, `transactionId` is then the Safe transaction hash. A pin read has `kind: "policy-read"` and the address.
- `decision`. One of the five below.
- `status`. The HTTP status the Signer answered with.
- `reason`. Why it didn't sign: the policy's reason for `refused`, or the error otherwise.

| `decision` | `status` | What happened |
| --- | --- | --- |
| `signed` | 200 | The Signer signed. |
| `read` | 200 | A policy read was answered. Nothing was signed. |
| `refused` | 403 | The policy refused the transaction. The engine reports `SIGNER_REFUSED`. |
| `rejected` | 400, 401, 404 | The Signer would never sign this request. 400 is a malformed request, 401 a missing or wrong token, 404 an address the config doesn't hold (also a policy read for one). |
| `failed` | 500 | The backend failed to sign, for example Privy or KMS was unreachable or refused the credentials. |

To match a signature with the engine's records, look up `transactionId`. The engine reports the same value as an item's `transactionHash` in `GET /v1/dispatch/:id` ([`docs/api.md`](./api.md)). A Base fee-bump or a Solana resubmission is a new transaction, so it has its own `signed` line and its own `transactionId`. A `signed` line with no matching engine transaction means the worker stopped, or rejected the signature, before writing the transaction down. The engine writes every transaction down before sending it (ADR-0041), so it sent nothing in either case.

Alert on these:

- Any `refused`. Either the policy is wrong for real traffic, or something asked for a transaction you did not allow.
- Any `failed`. The backend can't sign, so Calls are failing.
- Any `rejected` with status 401. Either the tokens disagree, or something other than your worker can reach the Signer.
- Any `rejected` with status 404. The engine's Sender address and the Signer's config disagree.

## 10. Troubleshoot from the engine's side

When a Call's first signing fails, the Call is `FAILED` with a structured error in its item's `error` field, and the worker logs `call(s) failed`. Nothing was sent, so after you fix the cause, submit the payment again with a new `Idempotency-Key`.

`SIGNER_REFUSED` means the policy refused the transaction. The message is `signer refused: <reason>`, with the same reason as the audit line. It is definite. The Call is `FAILED` and never retried. A refused Base fee-bump stops bumping, and the original transaction is still tracked. A refused Solana resubmission fails the Call.

`SIGNER_UNREACHABLE` covers every other Signer failure. Its message names the cause:

| Message | Cause |
| --- | --- |
| `failed to reach signer at <url>` | The Signer is down, `SIGNER_URL` is wrong, the network blocks the worker, or the Signer took longer than `RPC_TIMEOUT_MS` (15 seconds by default). |
| `signer responded with 401` | `SIGNER_AUTH_TOKEN` differs between the worker and the Signer, or the worker has none. |
| `signer responded with 404` | The Sender address is not in the Signer's config. |
| `signer responded with 500` | The backend failed. The Signer's audit line for the request has the reason. |
| `[signer pins the multisig]` or `[signer pins the Safe]` at startup | The Signer's policy for the engine's key pins a different account, none, or (Base) lacks the chain. Fix `allowedMultisig`, or `allowedSafe` and `chainIds`, for that key. An "older Signer" message means upgrade the Signer (ADR-0055). |
| `signer responded with 400` | The Signer could not parse the request. The usual cause is an engine and a Signer from different versions of the contract. Upgrade them together (ADR-0046). The audit line has the error. |
| `signer responded with 403` | Something in front of the Signer, such as a proxy, refused the request. A policy refusal always has the Signer's reason and is reported as `SIGNER_REFUSED` instead. |
| `signer returned a signature for 0x…, expected 0x…` | Base. The Signer signed with a different key than the Sender's. The nonce is released and nothing is sent. Check the `keyRef`. |
| `signer returned a signature that does not verify for address …` | Solana. The same as above. |

## Mainnet checklist

Clear every item before the first mainnet transaction.

- [ ] No address in the mainnet Signer's config uses the `keyfile` backend, and its startup log has no `WARNING: the keyfile backend` line.
- [ ] If any address uses `local`: the passphrase and the key files are backed up separately, the passphrase comes from a mounted secret file, the keystore directory is `0700`, and every `local` address has a tight policy and holds little.
- [ ] `SIGNER_AUTH_TOKEN` is a fresh random value (`openssl rand -hex 32`), set identically on the worker and the Signer, used in no other environment, and not Compose's `dev-only-signer-token`.
- [ ] Every address has a policy. On Base it has `chainIds: [8453]`. Every address has `allowedDestinations` and caps sized to what one transaction should ever move.
- [ ] Every Privy wallet has an owner (`owner_id` set), `PRIVY_AUTHORIZATION_KEY` is set on the Signer, and the authorization key is a fresh one made for mainnet that has never been pasted into chat, a ticket, or a commit.
- [ ] The KMS path is proven against real KMS. Today it is proven only against mocks (#61). Before mainnet, create a testnet key the same way (same key spec, same IAM policy), and run `RUN_AWS_KMS=1 pnpm test src/signer/aws-kms-e2e.test.ts` against Base Sepolia, and Solana devnet with `AWS_KMS_ED25519_KEY_ID`. The variables are listed in [`.env.example`](../.env.example). Fix anything it finds before relying on the mainnet key.
- [ ] Each KMS credential can call only `kms:GetPublicKey` and `kms:Sign`, on its own keys.
- [ ] The Signer is reachable only from the worker. Its port is not published to the internet.
- [ ] The audit log goes somewhere durable, with alerts on `refused`, `failed`, and `rejected` 401 and 404 lines.
- [ ] A small mainnet smoke test has landed first: one small Payment per enabled chain, confirmed on-chain, with a matching `signed` audit line, before any real volume.
- [ ] Every mainnet chain in `ENABLED_CHAINS` stays enabled while it has transactions in flight. Removing a chain with a `PENDING` transaction stops confirmation tracking for every chain until #57 is fixed.
- [ ] If you use a Multisig Sender, the engine's key can never approve. On Solana the member key holds exactly Initiate and Execute (permission mask 5) and never Vote. On Base the executor is not an owner of the Safe and is registered as a delegate. The engine refuses to start otherwise, but check it in the multisig's app yourself.
- [ ] Every multisig key has `allowedMultisig` (Solana) or `allowedSafe` and `chainIds: [8453]` (Base) in its policy, pinned to the one multisig. The engine's startup checks this (ADR-0055): it refuses to start if the Signer reports a different pin or none, so confirm the worker's startup log has `checks passed`.
- [ ] A multisig's engine key on `local` is a weaker choice than on `aws-kms` or `privy`: a host compromise exposes it. It can only propose, execute and close, so the policy pin matters most for it.
- [ ] Solana: the multisig's rent collector is the member key's address. Without it, proposal rent is never refunded and the member key drains.
- [ ] Solana: the Squads `ProgramConfig` creation fee and the mainnet rent rate (`getMinimumBalanceForRentExemption`) are read on mainnet before sizing the member key's balance. The spike measured devnet only. The member key must hold the rent of every proposal open at once, plus fees.
- [ ] Base: `BASE_SAFE_API_KEY` is set to a key on a production plan of the Safe Transaction Service, and its monthly quota, read from the Safe developer dashboard, covers about one request a minute for each open proposal. Unauthenticated use (2 requests a second, 5,000 a month) is not enough.
- [ ] Base: the `MultiSendCallOnly` addresses have code on Base mainnet. The spikes ran on Base Sepolia only, and the mainnet check has never been done. A read-only check for each of `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` (Safe 1.4.1), `0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B` and `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` (Safe 1.3.0): the result must not be `0x`. Repeat it for each address.

  ```sh
  curl -s https://mainnet.base.org -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x9641d764fc13c8B624c04430C7356C1C7C8102e2","latest"]}'
  ```

- [ ] The approval deadline (`SOLANA_APPROVAL_DEADLINE_MS`, `BASE_APPROVAL_DEADLINE_MS`, 72 hours by default) is longer than the multisig's time lock plus the time your Approvers take to vote. The engine abandons an approved proposal that is still waiting out its time lock when the deadline passes.
- [ ] The Approvers know to compare each proposal with their own record of the payments, not with the engine's `expected` totals, and have the verifier (`verifier/`) installed and working against your RPC. `expected` is not a control.
- [ ] Your callers treat `APPROVAL_TIMEOUT` as ambiguous and check the multisig before sending again. The engine re-watches a timed-out proposal for 30 days by default, so a late execution is reported only inside that window.
- [ ] Treasury: the hot Sender's working balance is sized to what you accept losing with its key, and its policy caps match.
