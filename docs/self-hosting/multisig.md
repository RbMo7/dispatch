# Set up a multisig Sender

This guide is for an operator who wants people to approve the money the engine moves. It covers two independent patterns, on Solana with Squads v4 and on Base with Safe:

- **Treasury.** A multisig holds most of the funds and tops up an ordinary hot Sender. No engine setting is involved.
- **Multisig Sender.** The Sender is the multisig. The engine proposes each bundle of payments, the Approvers vote in the multisig's app, and the engine executes once enough have approved.

[Pay from a multisig](../guides/multisig.md) is the developer's side: the statuses, the `approval` block and what a timeout means for a caller. This page helps you choose, sets up each chain, has the page to hand your Approvers, and lists the behaviors to know before you rely on it.

Read [Set up a Signer](./signer.md) first. Every key in this guide lives behind the Signer, and the [mainnet checklist](./mainnet.md) includes the multisig items.

## What is built, and what is not

This guide describes what the code does. Batch proposals on Solana are **not built** (issue #91). Follow-up not done: human checks before mainnet (#96: the Squads app's labels and rent collector screen, Safe plan quotas, delegate removal, self-hosting, mainnet read-only facts). [After a timeout](#what-the-engine-does-and-does-not-do-after-a-timeout) covers what happens when nobody decides. Nothing here has been run on mainnet. The whole path (the API, the Coordinator, a real Signer enforcing the policy, and the chain) is proven end to end against Solana devnet (`RUN_SQUADS=1`, issue #78: approve, reject, timeout then a human's late execution, Funding Check, Signer policy) and against Base Sepolia with the hosted Safe Transaction Service (`RUN_SAFE=1`, issue #87: the same, plus the one-open-proposal queue and the stale-nonce guard). Both are opt-in, spend a little testnet funds, and are not part of CI.

## Choose a Treasury or a Multisig Sender

| | Treasury | Multisig Sender |
| --- | --- | --- |
| Where the funds sit | Most in the multisig, a working balance in a hot Sender | All in the multisig |
| Who approves | M-of-N approve each top-up | M-of-N approve every payment run |
| Engine settings | None. The Sender is configured as usual. | `SOLANA_SENDER_MODE=multisig` or `BASE_SENDER_MODE=safe`, and more |
| A stolen Sender key loses | The working balance | The engine's key can only propose and execute, so nothing, if the Signer's policy holds |
| Throughput | As fast as a plain Sender | One approval round per proposal. On Base, one proposal in flight per Safe at a time. |
| Failure when short | `INSUFFICIENT_FUNDS`, naming the top-up | `INSUFFICIENT_FUNDS`, naming which balance is short |

Choose a **Treasury** when you can accept a hot wallet with a bounded balance, and you want speed. Choose a **Multisig Sender** when no single key or host may move a payment run on its own. They are independent: you may use either, both or neither.

If your callers send many small Dispatches, a Multisig Sender produces many small proposals and so many approvals (see [below](#many-small-dispatches-mean-many-small-proposals)). Use a Treasury with a hot Sender for that traffic.

### Treasury

1. Create a multisig on the chain (a Squads multisig on Solana, a Safe on Base) with your Approvers as members or owners and a threshold such as 2 of 3.
2. Set up the Sender as an ordinary key on any Signer backend, with a policy, as in [Set up a Signer](./signer.md). Put its address in `SOLANA_SENDER_ADDRESS` or `BASE_SENDER_ADDRESS`, as usual. Do not set the Sender mode.
3. Move a working balance from the multisig to the Sender. The Approvers do this in the Squads or Safe app.
4. When a Dispatch finds the Sender short, the Funding Check fails the shortfall Calls with `INSUFFICIENT_FUNDS`. Its `chainDetail` is `{ "asset": "USDC", "short": "40" }`: `short` is the extra the Sender needs, in the asset's smallest unit. On Solana it includes the SOL for fees and for new token accounts. The Approvers send that much, at least, and the caller sends the payments again with a **new** `Idempotency-Key`.

The engine never sees the Treasury. Size the working balance to the largest run you are willing to lose with the Sender key, and set the Sender's Signer policy caps to match.

## What the engine's key is allowed to do

The engine proposes and executes, and never approves. No host the engine runs on, and no key the Signer holds for it, can reach the threshold. The engine refuses to start if its key could vote or is an owner, and the Signer's policy pins that key to the one multisig, so it can sign nothing else. At startup the engine asks the Signer what the key is pinned to, and refuses to start for a key that is unpinned, pinned elsewhere, or on a Signer too old to say.

## Squads on Solana

This runbook sets up a Multisig Sender on Solana: a Squads v4 multisig pays, your Approvers vote in the Squads app, and the engine proposes and executes.

You need a Signer ([Set up a Signer](./signer.md)) and the engine's Solana settings already working in single mode.

### What the engine's key is on Solana

The engine acts through one ordinary Solana key, the **member key**. It is a member of the multisig with exactly **Initiate and Execute** permissions, which is permission mask **5** (Initiate is 1, Vote is 2, Execute is 4). It pays fees and the rent of every proposal. It must never be able to vote. The engine refuses to start if the key holds Vote, if it lacks Initiate or Execute, or if its mask is anything but 5.

### Create the member key

Create the member key on a Signer backend first, because you need its address to create the multisig. With the `local` backend:

```sh
export SIGNER_KEYSTORE_DIR=/var/lib/signer/keystore
export SIGNER_KEYSTORE_PASSPHRASE_FILE=/run/secrets/keystore-passphrase
pnpm signer keys new --curve ed25519 --name squads-member    # prints the address
```

For `aws-kms` and `privy`, follow [Set up a Signer](./signer.md). Do not reuse a key that holds other funds.

### Create the multisig

Create a Squads v4 multisig, in the Squads app or with the Squads SDK, with:

- the **Approvers** as members with the **Vote** permission,
- a threshold such as 2 of 3,
- the **member key** as a member with Initiate and Execute only (mask 5),
- a **time lock** if you want one (see [the deadline and the time lock](#the-approval-deadline-and-the-time-lock)),
- the **rent collector set to the member key's address**.

Why the rent collector matters: the engine pays the rent for each proposal's two accounts when it proposes, about 4.7 million lamports for one transfer and about 5.2 million for a bundle of 12 token transfers at the devnet rent rate. Squads refunds that rent only when the proposal is closed, and only to the multisig's rent collector. With no rent collector, closing fails with `RentReclamationDisabled` (error 6032), the rent is never recovered, and the member key drains. With a collector that is not the member key, the rent goes there instead of back to the engine. The engine closes finished proposals itself.

Check the setting: the engine's startup logs a warning if there is no rent collector (`the multisig has no rent collector`) or if it is a different address. Whether the Squads app has a screen to read or change the rent collector was not checked for this guide. In the program it is a field of the multisig account, set at creation or changed by a config transaction that the Approvers vote on. The engine never changes the multisig's settings.

Use the **multisig account address** (not the vault) in the engine's settings. The Sender is the multisig's vault at index 0, which is the default vault in Squads. The engine derives the vault address itself.

### Configure the Signer for the member key

Add the member key to `SIGNER_CONFIG`, pinned to the one multisig with `allowedMultisig` ([Set up a Signer](./signer.md#4-write-a-policy-for-every-address)):

```json
{
  "<member key address>": {
    "curve": "ed25519",
    "backend": "local",
    "keyRef": "squads-member",
    "policy": { "allowedMultisig": "<multisig account address>" }
  }
}
```

The key may then sign only that multisig's `vaultTransactionCreate`, `proposalCreate`, `vaultTransactionExecute` and `vaultTransactionAccountsClose`, plus the compute-budget instructions that go with them, as fee payer. It refuses votes, config transactions and every other program. If you also set `allowedDestinations`, list the Squads program in it (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`). The engine's startup checks that the Signer's policy pins this key to the multisig, and refuses to start otherwise.

### Configure the engine for Squads

These go on the worker, next to your other Solana settings. [`.env.example`](../../.env.example) has the same names.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOLANA_SENDER_MODE` | `single` | `multisig` turns this on. Anything else but `single` is a startup error. |
| `SOLANA_MULTISIG_ADDRESS` | none | The Squads multisig account. Required in multisig mode. |
| `SOLANA_MULTISIG_MEMBER_ADDRESS` | none | The member key's address. Required in multisig mode. It must be on the ed25519 curve and differ from the multisig. |
| `SOLANA_SENDER_ADDRESS` | the derived vault | Leave it unset. If you set it, it must equal the vault, or the engine refuses to start. |
| `SOLANA_APPROVAL_DEADLINE_MS` | `259200000` (72 hours) | How long a proposal waits for approval, counted from its creation. A whole number of milliseconds above zero. |
| `SOLANA_APPROVAL_REWATCH_WINDOW_MS` | `2592000000` (30 days) | How long, counted from the timeout, the engine keeps reading a timed-out proposal for a late execution or rejection. See [after a timeout](#what-the-engine-does-and-does-not-do-after-a-timeout). |

In single mode, setting `SOLANA_MULTISIG_ADDRESS` or `SOLANA_MULTISIG_MEMBER_ADDRESS` is an error, so a half-edited config never starts quietly.

`SOLANA_KNOWN_TOKENS` is read as usual: a token Payment needs its mint configured. A fixed `SOLANA_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` is applied to the proposal's create transaction. An `auto` price is not applied to proposals. The execute transaction asks for a 256 KB heap and a compute-unit limit from a simulation, and carries no price instruction.

```
SOLANA_SENDER_MODE=multisig
SOLANA_MULTISIG_ADDRESS=<multisig account address>
SOLANA_MULTISIG_MEMBER_ADDRESS=<member key address>
SOLANA_APPROVAL_DEADLINE_MS=259200000
```

### Fund the vault and the member key

The engine checks both before it proposes, in the Funding Check:

- **The vault** pays the payments, and the SOL for new recipient token accounts. Send it the money from outside, or from a Squads transfer. Its address is in the engine's startup log (`vault`). Confirm that it is the vault the Squads app shows for index 0.
- **The member key** pays each proposal's fee, the rent of its accounts, and the execute fee. The rent stays locked until the proposal is closed, so size the balance for **all proposals open at once**. At the devnet rent rate, 42 proposals of 12 token transfers lock about 0.22 SOL. The mainnet rent rate and the Squads program's creation fee were **not read** in the spike. The engine reads the rent rate from the chain when it sizes a proposal, so a short balance shows up as `INSUFFICIENT_FUNDS` with `holder: "memberKey"`. Read the numbers yourself before you size a mainnet balance.

Both balances are reduced by what open proposals already hold, so a second Dispatch cannot spend what the first is waiting to pay.

### Read the Squads startup checks

Start the worker. Before anything is sent it checks, and refuses to start on:

| Message contains | Meaning |
| --- | --- |
| `invalid Solana multisig sender config` | A bad or missing variable. Every problem is listed. |
| `[multisig readable]` | The RPC could not read the multisig, or it is not a Multisig account. |
| `[multisig exists]` | No account at `SOLANA_MULTISIG_ADDRESS`: wrong address, or wrong cluster. |
| `[multisig owned by Squads v4]` | The address is not a Squads v4 multisig account (a vault or a v3 multisig). |
| `[member is in the multisig]` | The member key is not a member. |
| `[member cannot vote]` | The member key holds Vote. Remove it. |
| `[member can initiate and execute]` | It lacks Initiate or Execute. |
| `[member permission mask is exactly 5]` | Any other mask. |
| `[signer can sign for the member]` | The Signer has no key for the member address, or the engine cannot reach it. |
| `[signer pins the multisig]` | The Signer's policy for the member key pins another multisig or none (`allowedMultisig`), or the Signer is too old to say (upgrade it). |
| `[sender is the vault]` | The configured Sender is not the vault. |

It only **warns** (in the log, then carries on) when the threshold is 1, when the threshold is higher than the number of voting members, when there is no rent collector or it is not the member key, and when the multisig's time lock is longer than `SOLANA_APPROVAL_DEADLINE_MS`. On success it logs `Solana multisig sender checks passed` with the multisig, vault and member.

### What a large Dispatch looks like

A proposal holds at most **12 transfers** (fewer if the create transaction would pass Solana's 1,232-byte limit, which a mixed bundle with new token accounts can). A Dispatch is split in order into as many proposals as it needs, and a proposal never mixes Dispatches. The Approvers vote on each one. With a threshold of 2, that is 2 votes per proposal:

| Recipients | Proposals (at 12 each) | Votes at a threshold of 2 |
| --- | --- | --- |
| 12 | 1 | 2 |
| 100 | 9 | 18 |
| 500 | 42 | 84 |

The engine creates the proposals one after another, and they can all be open at the same time. They are independent and may be approved and executed in any order, and each has its own deadline from its own creation. Batches, which would let a few votes cover a whole run, are **not** in v1 (issue #91): the Squads app might not show a batch's contents, and a batch executes strictly in order.

A Multisig Sender on Solana proposes **only** native SOL transfers and SPL or Token-2022 `transferChecked` from the vault. Any other `call` item (a program call, another System or Token instruction, a payment from another account) is refused with `CHAIN_REJECTED`. If one Call of a Dispatch is refused while the engine plans its proposals, **every Call of that Dispatch claimed with it fails** with that error, so send unusual calls through a plain Sender. `POST /v1/dispatch` refuses such an item up front with a 400 naming it (#94). The claim-time check is only the safety net.

### A Squads example, end to end

2-of-3 Approvers, a `local` member key, a Dispatch of 30 USDC payments:

1. `pnpm signer keys new --curve ed25519 --name squads-member` prints `Mem…`.
2. In Squads, create a multisig with three Voters, threshold 2, the member `Mem…` with Initiate and Execute, and rent collector `Mem…`. Note its address `Msig…`.
3. In `SIGNER_CONFIG`: `"Mem…": { "curve": "ed25519", "backend": "local", "keyRef": "squads-member", "policy": { "allowedMultisig": "Msig…" } }`.
4. On the worker: `SOLANA_SENDER_MODE=multisig`, `SOLANA_MULTISIG_ADDRESS=Msig…`, `SOLANA_MULTISIG_MEMBER_ADDRESS=Mem…`, and `SOLANA_KNOWN_TOKENS` with USDC.
5. Send the vault its USDC and some SOL, and send `Mem…` about 0.05 SOL. Start the worker and read `Solana multisig sender checks passed`.
6. `POST /v1/dispatch` with 30 payments. It becomes three proposals (12, 12 and 6, if the bytes fit). `GET` shows each item `awaiting_approval` with its `approval` block.
7. Each Approver checks the three proposals (by eye or with the verifier) and approves. Once two have, the engine executes. The items go to `broadcasting`, then `confirmed`.

## Safe on Base

This runbook sets up a Multisig Sender on Base: a Safe pays, its owners confirm in the Safe app, and the engine proposes and executes.

The engine depends on the **Safe Transaction Service** (hosted by Safe, or run by you) to propose transactions and to read the owners' confirmations. There is no mode without it.

### What the engine's key is on Base

The engine acts through one ordinary key, the **executor**. It is **not an owner** of the Safe, so nothing it holds can approve. It does two jobs: it submits `execTransaction` (and pays its gas), and, once an owner has registered it as a **delegate**, it posts proposals to the service. The engine refuses to start if the executor is an owner.

### Create the Safe

Create a Safe on Base (Base Sepolia for a first run) in the Safe app, with your Approvers as owners and a threshold such as 2 of 3. The engine accepts Safe **1.3.0 and 1.4.1**, L1 or L2 variants, and refuses any other `VERSION()`. It warns (and does not refuse) about a threshold of 1, a guard, and enabled modules. A **guard or a module that gates execution is unsupported**: an `execTransaction` through one may revert, and the engine cannot see why.

### Create the executor key

Create a secp256k1 key on a Signer backend (`local`, `privy` or `aws-kms`), for example:

```sh
pnpm signer keys new --curve secp256k1 --name safe-executor    # prints the 0x address
```

Do **not** add it as an owner. Fund it with ETH for gas: it pays for every `execTransaction`, including Base's L1 data fee.

### Configure the Signer for the executor

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

Use `[84532]` on Base Sepolia. The key then signs only an `execTransaction` to that Safe and the matching Safe typed data, only as a delegatecall to MultiSendCallOnly, with zero gas and refund fields, so a proposal can never make the Safe pay the executor ([Set up a Signer](./signer.md#signing-a-safe-transaction)). If you also set `allowedDestinations`, list the Safe in it. The engine's startup checks that the Signer's policy pins this key to the Safe and allows the chain, and refuses to start otherwise.

### Register the executor as a delegate

An **owner** does this once. It tells the Safe Transaction Service that the executor may post proposals for the Safe. The service refuses a proposal from anyone else with HTTP 422. The engine's startup reads the delegate list and refuses to start if the executor is not on it, with this recipe in the message.

The owner signs EIP-712 typed data with their own key:

- domain: `{ name: "Safe Transaction Service", version: "1.0", chainId }`
- type: `Delegate(address delegateAddress, uint256 totp)`
- `totp`: `floor(unix_seconds / 3600)`. The signature is only valid in that hour, so send the request in the same hour.

Then send it with `POST <service url>/api/v2/delegates/`. This example uses a throwaway key placeholder. It shows the shape (the typed-data signing was run offline with a generated key, and the request itself was measured against the service in the spike, but this script was not run against it as written):

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

### The Safe Transaction Service and its API key

The hosted service is `https://api.safe.global/tx-service/base` for Base and `.../basesep` for Base Sepolia. The engine uses them by default for chain IDs 8453 and 84532 only. Any other chain ID needs `BASE_SAFE_TX_SERVICE_URL`.

- **Use an API key in production.** Get one at `developer.safe.global`. The engine sends it as `Authorization: Bearer <key>` and never logs it. Without one the hosted service allows **2 requests a second and 5,000 a month**, which is for exploration only. Watching one open proposal once a minute is about 43,000 requests a month, and the engine warns at startup when no key is set.
- **Plans.** Builder (free), Growth and Scale allow 5, 15 and 50 requests a second. The monthly quotas of the paid plans are **not published**, so read them from the Safe developer dashboard before you choose a plan. These plan figures come from the spike's reading of Safe's documentation, and the authenticated quotas were not tested.
- **Self-hosting.** You can run the service yourself (it needs Postgres, Redis, RabbitMQ and the service, with event indexing and no tracing node, according to the spike notes) and point `BASE_SAFE_TX_SERVICE_URL` at it. This repository has not run a self-hosted service.
- **Trust.** The service is a convenience for collecting signatures. The engine counts only confirmations that recover to a current owner (read on-chain) or an on-chain `approveHash`, against the Safe's real threshold. A lying service cannot add an approval. It can withhold one, so a proposal stalls.

### Configure the engine for Safe

| Variable | Default | Meaning |
| --- | --- | --- |
| `BASE_SENDER_MODE` | `single` | `safe` turns this on. |
| `BASE_SAFE_ADDRESS` | none | The Safe. Required in safe mode. A mixed-case address needs a correct checksum. |
| `BASE_SAFE_EXECUTOR_ADDRESS` | none | The executor. Required, and different from the Safe. It is the Sender whose nonce the engine owns. |
| `BASE_SENDER_ADDRESS` | the executor | Leave it unset. If set, it must equal the executor. |
| `BASE_SAFE_TX_SERVICE_URL` | the hosted service for chain 8453 or 84532 | The service's base URL (no `/api`). Required for any other chain ID. |
| `BASE_SAFE_API_KEY` | none | The service API key. Optional in code, needed in production. |
| `BASE_APPROVAL_DEADLINE_MS` | `259200000` (72 hours) | How long a proposal waits, counted from its creation. |
| `BASE_APPROVAL_REWATCH_WINDOW_MS` | `2592000000` (30 days) | How long, counted from the timeout, the engine keeps reading a timed-out proposal ([after a timeout](#what-the-engine-does-and-does-not-do-after-a-timeout)). |
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

A Safe Sender proposes **only** native transfers and ERC-20 `transfer` calls of tokens in `BASE_KNOWN_TOKENS`. Any other `call` item is refused at `POST /v1/dispatch` with a 400 naming the item (#94). If one still reached the engine, planning the proposals would refuse it with `CHAIN_REJECTED` and fail every Call of its Dispatch claimed with it. Bulk Call is not how a Safe Sender bundles: a request that sets `bulkCall` for a Multisig Sender is a 400.

### Fund the Safe and the executor

- **The Safe** pays the payments, native and ERC-20.
- **The executor** pays gas for each `execTransaction`, including the L1 data fee. The Funding Check prices it per proposal and counts what open proposals already hold.

A shortfall is `INSUFFICIENT_FUNDS` with `holder` set to `safe` or `executor`.

### Read the Safe startup checks

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
| `[signer pins the Safe]` | The Signer's policy for the executor pins another Safe or none (`allowedSafe`), lacks `BASE_CHAIN_ID` in `chainIds`, or the Signer is too old to say (upgrade it). |

Warnings only: a threshold of 1, a guard, enabled modules, and a missing `BASE_SAFE_API_KEY`. Success logs `Safe sender checks passed`.

### One open proposal per Safe, and a whole-Dispatch queue

The Safe's nonce is sequential, so the engine keeps **one open proposal per Safe**. A Dispatch that arrives while one is open waits, its items `queued` with no `approval` block, and becomes its own proposal when its turn comes. A proposal never joins another Dispatch's. A large Dispatch becomes several proposals one after another: 500 payments at the default limit are 10 proposals, each created only when the previous one is resolved, each needing its own confirmations. Relay Dispatch and the other chains are not blocked.

If a proposal times out, the next one reuses the Safe's current nonce. The Safe app then shows both at that nonce as alternatives, and only one can ever execute.

For throughput on Base, use a Treasury Safe funding a hot Sender, run as a second engine instance, because each engine has one Sender per chain.

### A Safe example, end to end

On Base Sepolia, a 2-of-3 Safe, a `local` executor, a Dispatch of 60 USDC payments:

1. Create the Safe `0xYourSafe…` and a key `safe-executor` (`0xExecutor…`). Fund `0xExecutor…` with test ETH.
2. Signer config: `"0xExecutor…": { "curve": "secp256k1", "backend": "local", "keyRef": "safe-executor", "policy": { "chainIds": [84532], "allowedSafe": "0xYourSafe…" } }`.
3. An owner runs the delegate script above, and checks the delegate list.
4. Worker: `BASE_SENDER_MODE=safe`, `BASE_SAFE_ADDRESS`, `BASE_SAFE_EXECUTOR_ADDRESS`, `BASE_KNOWN_TOKENS` with USDC, `BASE_SAFE_API_KEY`. Read `Safe sender checks passed`.
5. Send the USDC and some ETH to the Safe. `POST /v1/dispatch` with 60 payments. It becomes two proposals (50 and 10), queued in order.
6. The owners see the first in the Safe app, check it (or run the verifier), and confirm. At two confirmations the engine simulates, then submits `execTransaction`. Then the second proposal appears.

## For Approvers

This section is for the people who vote. Send it to them.

You never touch the engine or the Signer. You hold your own key in your own wallet, and you vote in the Squads app or the Safe app. The engine's key is not an Approver on either chain, and it cannot vote.

### What you do

- **Squads (Solana).** Open the multisig in the Squads app. A proposal appears in its transaction list. Open it, check its instructions against your own record of the payments, then approve or reject. Whether the app decodes every instruction clearly for a given proposal was not checked for this guide, which is why the verifier below exists.
- **Safe (Base).** Open the Safe in the Safe app. The engine's proposal is queued in the Safe's pending transactions. Open it, check the decoded MultiSend against your own record, then confirm or reject. Confirming is a signature, with no gas. In the app, the proposal shows as proposed by **the owner who registered the engine as a delegate**, not by the engine: the service records the engine separately as `proposedByDelegate`, and the engine sets the origin to `Dispatch engine`.

### What the service tells you

The caller can read the proposal's state from [Get a Dispatch](../openapi.yaml#get-a-dispatch). Each item that belongs to a proposal has an `approval` block:

```json
"approval": {
  "state": "awaiting",
  "approvals": 1,
  "threshold": 2,
  "deadline": "2026-10-25T09:00:00.000Z",
  "expected": { "recipients": 120, "totals": [{ "asset": "USDC", "amount": "125000000" }] },
  "chainRef": { "kind": "squads", "multisig": "<multisig>", "proposal": "<proposal>", "transactionIndex": 42 }
}
```

- `state` is `awaiting` (not yet at the threshold), `approved` (at the threshold, waiting for any time lock, or being executed) or `approved_after_deadline` (the proposal was approved after its deadline, so the engine will not execute it: execute or reject it in the app).
- `approvals` and `threshold` are the votes so far and the votes needed.
- `deadline` is when the engine stops waiting. Vote before it. After it the engine never executes the proposal, even if it is approved ([after a timeout](#what-the-engine-does-and-does-not-do-after-a-timeout)).
- `chainRef` is what to open in the app. On Base it is `{ "kind": "safe", "safe", "safeTxHash", "nonce" }`.
- `expected` is the number of distinct recipients and the total per asset, in the smallest unit, that the engine says the proposal pays. Several proposals for one Dispatch each carry their own share, so your own total will be larger than any one `expected`.

**`expected` only catches mistakes. It is not a control.** The engine wrote the proposal and wrote `expected`, so a compromised engine can propose the wrong payments and report totals that look right. If you approve because the totals matched, you have not checked anything.

### The check that counts

Compare the proposal's decoded payments against **your own record**: the payment file the Dispatch was made from, or the invoice list, not anything the engine or the caller's system gave you after the fact. Do it in the app by eye, or run the independent verifier, which reads the chain and your file and shares no code with the engine ([`verifier/README.md`](../../verifier/README.md)):

```sh
cd verifier && pnpm install

# Solana: the proposal address from chainRef.proposal
pnpm verify --chain solana --rpc-url "$SOLANA_RPC_URL" \
  --proposal <proposal address> --payments payments.csv

# Base: the Safe and the safeTxHash and nonce from chainRef; --bundle-size must equal the engine's BASE_SAFE_BUNDLE_LIMIT
pnpm verify --chain base --rpc-url "$BASE_RPC_URL" \
  --safe 0xYourSafe --safe-tx-hash 0x... --nonce 12 --bundle-size 50 \
  --payments payments.csv
```

Exit code 0 is `MATCH`, 1 is `MISMATCH`, 2 means nothing was verified. A `MATCH` proves the proposal makes the payments in your file. It does **not** prove that it is the right multisig, so confirm the multisig or Safe address, and the Squads program, that the tool prints. It does not prove your file is right, or that the payment will succeed. The verifier's tests run offline against fixtures, with two optional read-only live checks. Its README lists its limits. Notably, a Squads proposal that was already closed can no longer be read.

The rubber-stamp risk is the one that remains. Approvers who vote without comparing give a compromised engine a free pass, because nothing else in the system checks the payments inside a proposal. The Signer's policy pins the engine's key to the one multisig, but it does not decode the payments nested in a proposal.

## What the engine does, and does not do, after a timeout

Every proposal has a deadline, `SOLANA_APPROVAL_DEADLINE_MS` or `BASE_APPROVAL_DEADLINE_MS`, 72 hours by default and counted from the proposal's creation. It is global, with no per-request override. When it passes:

- **Built.** The Calls become `ABANDONED` with the error code `APPROVAL_TIMEOUT`. They are not `FAILED`, because the proposal may still be approved and executed by someone else. The engine **never executes a proposal after its deadline itself**, even if it was approved a minute later. The check runs before the execute step, so an approved proposal whose time lock runs past the deadline is also abandoned.
- **Re-watch (#88).** The engine keeps reading the timed-out proposal for `*_APPROVAL_REWATCH_WINDOW_MS` (30 days by default, counted from the timeout): at the normal watch cadence for the first day, then hourly. It still never executes it. What it does when it sees something:
  - Executed by someone else: the Calls become `CONFIRMED`, with that transaction's hash, and the worker logs `late_execution_detected`. On Safe the service's `isExecuted` is cross-checked against the executing transaction's receipt (it must have succeeded and carry this Safe's `ExecutionSuccess` event for this `safeTxHash`). Without that proof nothing settles.
  - Rejected, cancelled or stale before approval (Safe: the nonce taken by a different transaction, so a superseded proposal is also caught): the Calls become `FAILED` with `APPROVAL_REJECTED`.
  - Approved but not executed: the Calls stay `ABANDONED`, `approval.state` reads `approved_after_deadline`, and the worker logs an error containing `approved_after_deadline` at most once an hour. Execute or reject it in the app.
  - The window ends: the Calls stay `ABANDONED`, the worker logs `rewatch_window_ended` once, and a later execution goes **unseen**. A proposal that cannot be read keeps being retried with backoff until then.
  - There is no push: the outcome reaches a caller only through `GET /v1/dispatch/:id` and the logs (there are no webhooks).
- **Funds stay committed** while the engine is watching: the Funding Check counts the proposal's amounts on the vault or Safe and on the proposer's key until the proposal settles or the window ends. A new Dispatch can be refused with `INSUFFICIENT_FUNDS` (`chainDetail.committed` says how much is held). Rejecting a dead proposal in the app releases it at the next read.
- **What you do.** Treat an `APPROVAL_TIMEOUT` Call like any `ABANDONED` Call. **Do not blindly re-send**: the payment may still happen. Open the proposal in the Squads or Safe app (or run the verifier, which also shows its status) and decide. To make a timed-out proposal dead, an Approver must **reject** it in the app. The engine cannot cancel it. A timed-out Call carries no execute hash of its own.
- **Rent (Solana).** Finished and dead proposals (executed, rejected, cancelled, stale) are closed by the engine to reclaim rent, including timed-out ones that later resolve. What still needs closing is stored in the database, so a restart does not forget it.

A rejection that comes **before** the deadline works: the Calls become `FAILED` with `APPROVAL_REJECTED`, and are never retried. On Solana a proposal that becomes stale because the multisig's configuration changed counts as rejected unless it was already approved. An approved stale proposal can still execute, so the engine treats it like any approved one. On Base, a proposal is rejected when the Safe's nonce moves past it and the transaction executed at that nonce has a different hash. The engine's own execution also moves the nonce, so the nonce alone proves nothing.

## Behaviors to understand before you rely on it

### The approval deadline and the time lock

A Squads multisig can have a **time lock**: an approved proposal cannot execute until the lock has run, counted from the moment it became approved. The deadline counts from the proposal's creation. So:

- The deadline must be **longer than the time lock**, or every proposal times out. The engine only warns about this at startup on Solana.
- It must also be longer than **how long your Approvers take to vote, plus the time lock**. A proposal approved at hour 71 with a 6-hour lock is abandoned at hour 72 without being executed, because the deadline is checked before every execute attempt.
- A Safe has no time lock by default, and the engine does not support the modules that add one.

Set the deadline in the environment, and restart the worker.

### Many small Dispatches mean many small proposals

A proposal never mixes Dispatches, so that an Approver can check it against one caller's payment file. Every Dispatch therefore needs its own approvals, however small. A caller that sends a Dispatch per payment gets a proposal per payment. Tell your callers to batch small payments into fewer, larger Dispatches (up to 12 per proposal on Solana, 50 by default on Base), or use a Treasury with a hot Sender for that traffic.

### Fund the multisig before the vote

The Funding Check runs when the engine picks up a Dispatch, not when the Approvers vote. If the vault or Safe is short when the proposal executes, the execute fails its simulation (on Safe, with `GS013`) and the proposal stays approved. The engine retries until the deadline and then abandons the Calls. Keep the balance above everything open.

### An approved proposal whose execute fails

On either chain an approved proposal whose execute fails stays approved and executable. The engine reads the proposal after every failed execute. If someone else executed it, the Calls become `CONFIRMED`. If it is still approved, the engine tries again about a minute later, until the deadline, and then abandons the Calls. They become `FAILED` only once the proposal is rejected, cancelled or stale.

### Restarts

Every proposal is written down before it is sent, and the watch loop finds unfinished ones after a restart and re-sends the same bytes. What still needs closing on Solana is stored in the database, so a restart does not forget it. The engine retries a failed close a few times and logs when it gives up. A proposal whose send was never confirmed (`noted`) times out at the deadline like any other (`ABANDONED`), and while one is `noted` the engine builds no other proposal for that sender.

### A quick reference of results

| Outcome | Item status | Error code |
| --- | --- | --- |
| In a proposal, waiting | `awaiting_approval` | none |
| Waiting for its turn (Safe) or to be proposed | `queued` | none |
| Executed and landed | `confirmed` | none |
| Rejected or cancelled by Approvers before the deadline, or stale | `failed` | `APPROVAL_REJECTED` |
| No decision by the deadline | `abandoned` | `APPROVAL_TIMEOUT` |
| The Signer refused the proposal or execute | `failed` | `SIGNER_REFUSED` |
| A Call the multisig cannot hold, or a Safe the engine cannot propose for | `failed` | `CHAIN_REJECTED` |
| A balance is short | `failed` | `INSUFFICIENT_FUNDS`, with a `holder` |

## When something goes wrong

[Troubleshooting](./troubleshooting.md#multisig-sender) lists every multisig symptom with its cause and fix: a worker that will not start, `SIGNER_REFUSED` on a proposal, an item stuck in `awaiting_approval`, `GS013` and the rest.

## Mainnet checklist for a multisig

The items are in the [mainnet checklist](./mainnet.md), next to the Signer's own. Clear them in addition to the rest of that list.
