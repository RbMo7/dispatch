# Safe on Base

This runbook sets up a Multisig Sender on Base: a Safe pays, its owners confirm in the Safe app, and the engine proposes and executes. Read [Multisig](../multisig.md) first to check that a Multisig Sender is what you want.

The engine depends on the **Safe Transaction Service** (hosted by Safe, or run by you) to propose transactions and to read the owners' confirmations. There is no mode without it.

## What the engine's key is

The engine acts through one ordinary key, the **executor**. It is **not an owner** of the Safe, so nothing it holds can approve. It does two jobs: it submits `execTransaction` (and pays its gas), and, once an owner has registered it as a **delegate**, it posts proposals to the service. The engine refuses to start if the executor is an owner.

## 1. Create the Safe

Create a Safe on Base (Base Sepolia for a first run) in the Safe app, with your Approvers as owners and a threshold such as 2 of 3. The engine accepts Safe **1.3.0 and 1.4.1**, L1 or L2 variants, and refuses any other `VERSION()`. It warns (and does not refuse) about a threshold of 1, a guard, and enabled modules. A **guard or a module that gates execution is unsupported**: an `execTransaction` through one may revert, and the engine cannot see why.

## 2. Create the executor key

Create a secp256k1 key on a Signer backend (`local`, `privy` or `aws-kms`), for example:

```sh
pnpm signer keys new --curve secp256k1 --name safe-executor    # prints the 0x address
```

Do **not** add it as an owner. Fund it with ETH for gas: it pays for every `execTransaction`, including Base's L1 data fee.

## 3. Configure the Signer

Map the executor and pin the Safe with `allowedSafe` (it needs `chainIds`). One key acts as both delegate and executor:

```json
{
  "0xExecutor…": {
    "curve": "secp256k1",
    "backend": "local",
    "keyRef": "safe-executor",
    "policy": { "chainIds": [8453], "allowedSafe": "0xYourSafe…" }
  }
}
```

Use `[84532]` on Base Sepolia. The key then signs only an `execTransaction` to that Safe and the matching Safe typed data, only as a delegatecall to MultiSendCallOnly, with zero gas and refund fields, so a proposal can never make the Safe pay the executor ([Set up the Signer](../signer.md#signing-a-safe-transaction)). If you also set `allowedDestinations`, list the Safe in it. The engine's startup checks that the Signer's policy pins this key to the Safe and allows the chain, and refuses to start otherwise (ADR-0055).

## 4. Register the executor as a delegate

An **owner** does this once. It tells the Safe Transaction Service that the executor may post proposals for the Safe. The service refuses a proposal from anyone else with HTTP 422. The engine's startup reads the delegate list and refuses to start if the executor is not on it, with this recipe in the message.

The owner signs EIP-712 typed data with their own key:

- domain: `{ name: "Safe Transaction Service", version: "1.0", chainId }`
- type: `Delegate(address delegateAddress, uint256 totp)`
- `totp`: `floor(unix_seconds / 3600)`. The signature is only valid in that hour, so send the request in the same hour.

Then send it with `POST <service url>/api/v2/delegates/`. This example uses a throwaway key placeholder. It shows the shape (the typed-data signing was run offline with a generated key; the request itself was measured against the service in the spike, but this script was not run against it as written):

```js
// register-delegate.mjs: run by an OWNER. Needs: npm i viem
import { privateKeyToAccount } from 'viem/accounts';

const SERVICE = 'https://api.safe.global/tx-service/basesep'; // .../base for Base mainnet
const CHAIN_ID = 84532; // 8453 for Base mainnet
const SAFE = '0xYourSafe…';
const DELEGATE = '0xExecutor…'; // the engine's executor address
const owner = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY); // an owner of the Safe; never commit it

const totp = BigInt(Math.floor(Date.now() / 1000 / 3600));
const signature = await owner.signTypedData({
  domain: { name: 'Safe Transaction Service', version: '1.0', chainId: CHAIN_ID },
  types: { Delegate: [{ name: 'delegateAddress', type: 'address' }, { name: 'totp', type: 'uint256' }] },
  primaryType: 'Delegate',
  message: { delegateAddress: DELEGATE, totp },
});

const response = await fetch(`${SERVICE}/api/v2/delegates/`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SAFE_API_KEY}` },
  body: JSON.stringify({ safe: SAFE, delegate: DELEGATE, delegator: owner.address, label: 'Dispatch engine', signature }),
});
console.log(response.status, await response.text()); // 201 on success
```

The Safe SDK's `addSafeDelegate` does the same. The service answers 400 if `delegator` is not an owner. Whether the Safe app has a screen for this was not checked.

Check the registration:

```sh
curl -H "Authorization: Bearer $SAFE_API_KEY" \
  "https://api.safe.global/tx-service/basesep/api/v2/delegates/?safe=0xYourSafe…&delegate=0xExecutor…"
```

The answer lists the delegate with its `delegator`, `label` and `expiryDate` (`null` means it does not expire). The engine ignores a registration whose `expiryDate` has passed. Removing a delegate needs a `DELETE` with the same signed data. What happens to proposals already posted when a delegate is removed or expires was **not tested**.

Because the delegate's proposal is attributed to the registering owner, **that owner appears as the proposer of everything the engine proposes**. Tell your owners.

## 5. The Safe Transaction Service and its API key

The hosted service is `https://api.safe.global/tx-service/base` for Base and `.../basesep` for Base Sepolia. The engine uses them by default for chain IDs 8453 and 84532 only. Any other chain ID needs `BASE_SAFE_TX_SERVICE_URL`.

- **Use an API key in production.** Get one at `developer.safe.global`. The engine sends it as `Authorization: Bearer <key>` and never logs it. Without one the hosted service allows **2 requests a second and 5,000 a month**, which is for exploration only. Watching one open proposal once a minute is about 43,000 requests a month, and the engine warns at startup when no key is set.
- **Plans.** Builder (free), Growth and Scale allow 5, 15 and 50 requests a second. The monthly quotas of the paid plans are **not published**, so read them from the Safe developer dashboard before you choose a plan. These plan figures come from the spike's reading of Safe's documentation, and the authenticated quotas were not tested.
- **Self-hosting.** You can run the service yourself (it needs Postgres, Redis, RabbitMQ and the service, with event indexing and no tracing node, according to the spike notes) and point `BASE_SAFE_TX_SERVICE_URL` at it. This repository has not run a self-hosted service.
- **Trust.** The service is a convenience for collecting signatures. The engine counts only confirmations that recover to a current owner (read on-chain) or an on-chain `approveHash`, against the Safe's real threshold. A lying service cannot add an approval. It can withhold one, so a proposal stalls.

## 6. Configure the engine

| Variable | Default | Meaning |
| --- | --- | --- |
| `BASE_SENDER_MODE` | `single` | `safe` turns this on. |
| `BASE_SAFE_ADDRESS` | none | The Safe. Required in safe mode. A mixed-case address needs a correct checksum. |
| `BASE_SAFE_EXECUTOR_ADDRESS` | none | The executor. Required, and different from the Safe. It is the Sender whose nonce the engine owns. |
| `BASE_SENDER_ADDRESS` | the executor | Leave it unset. If set, it must equal the executor. |
| `BASE_SAFE_TX_SERVICE_URL` | the hosted service for chain 8453 or 84532 | The service's base URL (no `/api`). Required for any other chain ID. |
| `BASE_SAFE_API_KEY` | none | The service API key. Optional in code, needed in production. |
| `BASE_APPROVAL_DEADLINE_MS` | `259200000` (72 hours) | How long a proposal waits, counted from its creation. |
| `BASE_APPROVAL_REWATCH_WINDOW_MS` | `2592000000` (30 days) | How long, counted from the timeout, the engine keeps reading a timed-out proposal ([after a timeout](../multisig.md#what-the-engine-does-and-does-not-do-after-a-timeout)). |
| `BASE_SAFE_BUNDLE_LIMIT` | `50` | The most payments in one proposal (one MultiSend). A whole number from 1 to 300. |

The Safe settings are an error in single mode, as on Solana. `BASE_KNOWN_TOKENS` is read as usual, and an ERC-20 Payment needs its token configured.

```
BASE_SENDER_MODE=safe
BASE_SAFE_ADDRESS=0xYourSafe…
BASE_SAFE_EXECUTOR_ADDRESS=0xExecutor…
BASE_SAFE_API_KEY=<your service key>
BASE_APPROVAL_DEADLINE_MS=259200000
```

The engine bundles payments with **MultiSendCallOnly**, a delegatecall from the Safe, so ERC-20 payments come out of the Safe. It chooses the contract by the Safe's `VERSION()`: `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` for 1.4.1 and `0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B` for 1.3.0 (the Signer also allows `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D`, the 1.3.0 canonical deployment). Their code was checked on Base Sepolia only. The mainnet check is in the checklist.

A Safe Sender proposes **only** native transfers and ERC-20 `transfer` calls of tokens in `BASE_KNOWN_TOKENS`. Any other `call` item is refused at `POST /v1/dispatch` with a 400 naming the item (#94); if one still reached the engine, planning the proposals would refuse it with `CHAIN_REJECTED` and fail every Call of its Dispatch claimed with it. Bulk Call (ADR-0038) is not how a Safe Sender bundles: a request that sets `bulkCall` for a Multisig Sender is a 400.

## 7. Fund two balances

- **The Safe** pays the payments, native and ERC-20.
- **The executor** pays gas for each `execTransaction`, including the L1 data fee. The Funding Check prices it per proposal and counts what open proposals already hold.

A shortfall is `INSUFFICIENT_FUNDS` with `holder` set to `safe` or `executor`.

## 8. Start and read the startup checks

The worker refuses to start, printing `Safe sender startup checks failed (nothing was sent)` and one line per failure, when:

| Check | Meaning |
| --- | --- |
| `invalid Safe sender config` | A bad or missing variable. |
| `[service reachable]` | The Safe Transaction Service is down, or refused the key (401). |
| `[safe readable]`, `[chain id]`, `[safe exists]` | The RPC could not read the Safe, answered a different chain ID than `BASE_CHAIN_ID`, or there is no contract at the address. |
| `[safe version]` | Not 1.3.0 or 1.4.1. |
| `[executor is not an owner]` | The executor is an owner. Use a separate key. |
| `[service matches chain]` | The service's owners or threshold differ from the chain's, or it has no such Safe: usually the wrong service URL. |
| `[executor is a registered delegate]` | Step 4 was not done, or the registration expired. |
| `[signer can sign for the executor]` | The Signer has no key for the executor, or cannot be reached. |
| `[signer pins the Safe]` | The Signer's policy for the executor pins another Safe or none (`allowedSafe`), lacks `BASE_CHAIN_ID` in `chainIds`, or the Signer is too old to say (upgrade it). ADR-0055. |

Warnings only: a threshold of 1, a guard, enabled modules, and a missing `BASE_SAFE_API_KEY`. Success logs `Safe sender checks passed`.

## One open proposal per Safe, and a whole-Dispatch queue

The Safe's nonce is sequential, so the engine keeps **one open proposal per Safe**. A Dispatch that arrives while one is open waits, its items `queued` with no `approval` block, and becomes its own proposal when its turn comes. A proposal never joins another Dispatch's. A large Dispatch becomes several proposals one after another: 500 payments at the default limit are 10 proposals, each created only when the previous one is resolved, each needing its own confirmations. Relay Dispatch and the other chains are not blocked.

If a proposal times out, the next one reuses the Safe's current nonce. The Safe app then shows both at that nonce as alternatives, and only one can ever execute.

For throughput on Base, use a Treasury Safe funding a hot Sender, run as a second engine instance (one Sender per chain, ADR-0016).

## Worked example

On Base Sepolia, a 2-of-3 Safe, a `local` executor, a Dispatch of 60 USDC payments:

1. Create the Safe `0xYourSafe…` and a key `safe-executor` (`0xExecutor…`). Fund `0xExecutor…` with test ETH.
2. Signer config: `"0xExecutor…": { "curve": "secp256k1", "backend": "local", "keyRef": "safe-executor", "policy": { "chainIds": [84532], "allowedSafe": "0xYourSafe…" } }`.
3. An owner runs the delegate script above, and checks the delegate list.
4. Worker: `BASE_SENDER_MODE=safe`, `BASE_SAFE_ADDRESS`, `BASE_SAFE_EXECUTOR_ADDRESS`, `BASE_KNOWN_TOKENS` with USDC, `BASE_SAFE_API_KEY`. Read `Safe sender checks passed`.
5. Send the USDC and some ETH to the Safe. `POST /v1/dispatch` with 60 payments. It becomes two proposals (50 and 10), queued in order.
6. The owners see the first in the Safe app, check it (or run the verifier), and confirm. At two confirmations the engine simulates, then submits `execTransaction`. Then the second proposal appears.

