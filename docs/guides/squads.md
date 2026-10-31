# Squads on Solana

This runbook sets up a Multisig Sender on Solana: a Squads v4 multisig pays, your Approvers vote in the Squads app, and the engine proposes and executes. Read [Multisig](../multisig.md) first to check that a Multisig Sender is what you want.

You need a Signer ([Set up the Signer](../signer.md)) and the engine's Solana settings already working in single mode.

## What the engine's key is

The engine acts through one ordinary Solana key, the **member key**. It is a member of the multisig with exactly **Initiate and Execute** permissions, which is permission mask **5** (Initiate is 1, Vote is 2, Execute is 4). It pays fees and the rent of every proposal. It must never be able to vote. The engine refuses to start if the key holds Vote, if it lacks Initiate or Execute, or if its mask is anything but 5.

## 1. Create the member key

Create the member key on a Signer backend first, because you need its address to create the multisig. With the `local` backend:

```sh
export SIGNER_KEYSTORE_DIR=/var/lib/signer/keystore
export SIGNER_KEYSTORE_PASSPHRASE_FILE=/run/secrets/keystore-passphrase
pnpm signer keys new --curve ed25519 --name squads-member    # prints the address
```

For `aws-kms` and `privy`, follow [Set up the Signer](../signer.md). Do not reuse a key that holds other funds.

## 2. Create the multisig

Create a Squads v4 multisig, in the Squads app or with the Squads SDK, with:

- the **Approvers** as members with the **Vote** permission,
- a threshold such as 2 of 3,
- the **member key** as a member with Initiate and Execute only (mask 5),
- a **time lock** if you want one (see [the deadline and the time lock](../multisig.md#the-approval-deadline-and-the-time-lock)),
- the **rent collector set to the member key's address**.

Why the rent collector matters: the engine pays the rent for each proposal's two accounts when it proposes, about 4.7 million lamports for one transfer and about 5.2 million for a bundle of 12 token transfers at the devnet rent rate. Squads refunds that rent only when the proposal is closed, and only to the multisig's rent collector. With no rent collector, closing fails with `RentReclamationDisabled` (error 6032), the rent is never recovered, and the member key drains. With a collector that is not the member key, the rent goes there instead of back to the engine. The engine closes finished proposals itself.

Check the setting: the engine's startup logs a warning if there is no rent collector (`the multisig has no rent collector`) or if it is a different address. Whether the Squads app has a screen to read or change the rent collector was not checked for this guide. In the program it is a field of the multisig account, set at creation or changed by a config transaction that the Approvers vote on. The engine never changes the multisig's settings.

Use the **multisig account address** (not the vault) in the engine's settings. The Sender is the multisig's vault at index 0, which is the default vault in Squads. The engine derives the vault address itself.

## 3. Configure the Signer

Add the member key to `SIGNER_CONFIG`, pinned to the one multisig with `allowedMultisig` ([Set up the Signer](../signer.md#4-write-a-policy-for-every-address)):

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

The key may then sign only that multisig's `vaultTransactionCreate`, `proposalCreate`, `vaultTransactionExecute` and `vaultTransactionAccountsClose`, plus the compute-budget instructions that go with them, as fee payer. It refuses votes, config transactions and every other program. If you also set `allowedDestinations`, list the Squads program in it (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`). The engine's startup checks that the Signer's policy pins this key to the multisig, and refuses to start otherwise (ADR-0055).

## 4. Configure the engine

These go on the worker, next to your other Solana settings. [`.env.example`](../../.env.example) has the same names.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOLANA_SENDER_MODE` | `single` | `multisig` turns this on. Anything else but `single` is a startup error. |
| `SOLANA_MULTISIG_ADDRESS` | none | The Squads multisig account. Required in multisig mode. |
| `SOLANA_MULTISIG_MEMBER_ADDRESS` | none | The member key's address. Required in multisig mode. It must be on the ed25519 curve and differ from the multisig. |
| `SOLANA_SENDER_ADDRESS` | the derived vault | Leave it unset. If you set it, it must equal the vault, or the engine refuses to start. |
| `SOLANA_APPROVAL_DEADLINE_MS` | `259200000` (72 hours) | How long a proposal waits for approval, counted from its creation. A whole number of milliseconds above zero. |
| `SOLANA_APPROVAL_REWATCH_WINDOW_MS` | `2592000000` (30 days) | How long, counted from the timeout, the engine keeps reading a timed-out proposal for a late execution or rejection. See [after a timeout](../multisig.md#what-the-engine-does-and-does-not-do-after-a-timeout). |

In single mode, setting `SOLANA_MULTISIG_ADDRESS` or `SOLANA_MULTISIG_MEMBER_ADDRESS` is an error, so a half-edited config never starts quietly.

`SOLANA_KNOWN_TOKENS` is read as usual: a token Payment needs its mint configured. A fixed `SOLANA_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` is applied to the proposal's create transaction. An `auto` price is not applied to proposals. The execute transaction asks for a 256 KB heap and a compute-unit limit from a simulation, and carries no price instruction.

```
SOLANA_SENDER_MODE=multisig
SOLANA_MULTISIG_ADDRESS=<multisig account address>
SOLANA_MULTISIG_MEMBER_ADDRESS=<member key address>
SOLANA_APPROVAL_DEADLINE_MS=259200000
```

## 5. Fund two balances

The engine checks both before it proposes (the Funding Check, ADR-0043 and ADR-0054):

- **The vault** pays the payments, and the SOL for new recipient token accounts. Send it the money from outside, or from a Squads transfer. Its address is in the engine's startup log (`vault`). Confirm that it is the vault the Squads app shows for index 0.
- **The member key** pays each proposal's fee, the rent of its accounts, and the execute fee. The rent stays locked until the proposal is closed, so size the balance for **all proposals open at once**. At the devnet rent rate, 42 proposals of 12 token transfers lock about 0.22 SOL. The mainnet rent rate and the Squads program's creation fee were **not read** in the spike. The engine reads the rent rate from the chain when it sizes a proposal, so a short balance shows up as `INSUFFICIENT_FUNDS` with `holder: "memberKey"`. Read the numbers yourself before you size a mainnet balance.

Both balances are reduced by what open proposals already hold, so a second Dispatch cannot spend what the first is waiting to pay.

## 6. Start and read the startup checks

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
| `[signer pins the multisig]` | The Signer's policy for the member key pins another multisig or none (`allowedMultisig`), or the Signer is too old to say (upgrade it). ADR-0055. |
| `[sender is the vault]` | The configured Sender is not the vault. |

It only **warns** (in the log, then carries on) when the threshold is 1, when the threshold is higher than the number of voting members, when there is no rent collector or it is not the member key, and when the multisig's time lock is longer than `SOLANA_APPROVAL_DEADLINE_MS`. On success it logs `Solana multisig sender checks passed` with the multisig, vault and member.

## What a large Dispatch looks like

A proposal holds at most **12 transfers** (fewer if the create transaction would pass Solana's 1,232-byte limit, which a mixed bundle with new token accounts can). A Dispatch is split in order into as many proposals as it needs, and a proposal never mixes Dispatches. The Approvers vote on each one. With a threshold of 2, that is 2 votes per proposal:

| Recipients | Proposals (at 12 each) | Votes at a threshold of 2 |
| --- | --- | --- |
| 12 | 1 | 2 |
| 100 | 9 | 18 |
| 500 | 42 | 84 |

The engine creates the proposals one after another, and they can all be open at the same time. They are independent and may be approved and executed in any order, and each has its own deadline from its own creation. Batches, which would let a few votes cover a whole run, are **not** in v1 (issue #91): the Squads app might not show a batch's contents, and a batch executes strictly in order.

A Multisig Sender on Solana proposes **only** native SOL transfers and SPL or Token-2022 `transferChecked` from the vault. Any other `call` item (a program call, another System or Token instruction, a payment from another account) is refused with `CHAIN_REJECTED`. If one Call of a Dispatch is refused while the engine plans its proposals, **every Call of that Dispatch claimed with it fails** with that error, so send unusual calls through a plain Sender. `POST /v1/dispatch` refuses such an item up front with a 400 naming it (#94); the claim-time check is only the safety net.

## Worked example

2-of-3 Approvers, a `local` member key, a Dispatch of 30 USDC payments:

1. `pnpm signer keys new --curve ed25519 --name squads-member` prints `Mem…`.
2. In Squads, create a multisig with three Voters, threshold 2, the member `Mem…` with Initiate and Execute, and rent collector `Mem…`. Note its address `Msig…`.
3. In `SIGNER_CONFIG`: `"Mem…": { "curve": "ed25519", "backend": "local", "keyRef": "squads-member", "policy": { "allowedMultisig": "Msig…" } }`.
4. On the worker: `SOLANA_SENDER_MODE=multisig`, `SOLANA_MULTISIG_ADDRESS=Msig…`, `SOLANA_MULTISIG_MEMBER_ADDRESS=Mem…`, and `SOLANA_KNOWN_TOKENS` with USDC.
5. Send the vault its USDC and some SOL, and send `Mem…` about 0.05 SOL. Start the worker and read `Solana multisig sender checks passed`.
6. `POST /v1/dispatch` with 30 payments. It becomes three proposals (12, 12 and 6, if the bytes fit). `GET` shows each item `awaiting_approval` with its `approval` block.
7. Each Approver checks the three proposals (by eye or with the verifier) and approves. Once two have, the engine executes. The items go to `broadcasting`, then `confirmed`.

