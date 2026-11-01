# The Dispatch lifecycle

A Managed Dispatch has a status, and so does each of its items. Act on the item status: it says what happened to that payment or call. The Dispatch status is a summary for lists and dashboards. A Relay Dispatch is one transaction, so it has one status, from the item list.

![How an item moves. Most go from queued to broadcasting to confirmed. A multisig item waits in awaiting_approval first.](./images/dispatch-lifecycle.svg)

## From submitted to confirmed

1. **Stored.** `POST /v1/dispatch` checks the request and stores it. Every item is `queued`. Nothing has checked a balance, signed anything or touched the chain, so the `202` answer carries no chain result.
2. **Claimed.** The worker looks for queued Dispatches every two seconds, between rounds of work, and claims yours. From here it cannot be cancelled.
3. **Checked.** The [Funding Check](#the-funding-check) adds up what the Dispatch needs, per asset and payer, and compares that with the balances on chain. Items the payer cannot cover fail now with `INSUFFICIENT_FUNDS`, before anything is signed.
4. **Built and signed.** The worker builds each transaction and assigns its nonce. The Signer signs it if the key's policy allows, and the worker checks that the signature comes from the Sender's key.
5. **Written down, then sent.** The worker writes the signed transaction and its hash to Postgres before it sends it, so a crash can never lose track of a transaction that might land. The item is `broadcasting`.
6. **Tracked.** The worker checks the transaction until the chain answers. The item becomes `confirmed`, or `failed` if the chain refused or reverted it.

On Solana several items, even from different Dispatches, can share one transaction, so they share a `transactionHash`. On Base each item is its own transaction, unless you use [Bulk Call](./guides/bulk-call.md).

## Item statuses

| Status | What happened | Final | What your code does |
| --- | --- | --- | --- |
| `queued` | Stored, not yet in a transaction. For a Multisig Sender: claimed, but not yet in a Proposal, or waiting for an earlier Proposal on the same Safe. | No | Wait. |
| `awaiting_approval` | In a multisig Proposal that the Approvers have not decided yet. Only for a Multisig Sender. | No | Wait. The `approval` block shows the votes and the deadline. |
| `broadcasting` | Signed and written down, and sent or about to be sent. Includes a send whose outcome is not known yet. | No | Wait. Do not send it again. The transaction may land. |
| `confirmed` | Landed on the chain and succeeded. | Yes | Record `transactionHash`. |
| `failed` | Definitely did not happen: refused before signing, refused by the Signer or the chain, or reverted. | Yes | Read `error.code`. Fix the cause and send it again with a new `Idempotency-Key`. |
| `abandoned` | The engine stopped waiting without a definite answer. The transaction or the Proposal may still land. | Yes, for the engine | Check the chain or the multisig before you send it again, or the payment may happen twice. |
| `cancelled` | Withdrawn before the engine claimed it. Nothing was signed or sent. | Yes | Send it again with a new `Idempotency-Key` if you still want it. |

## The Dispatch status

The top-level `status` of a Managed Dispatch is one of these:

| Status | Means |
| --- | --- |
| `queued` | Stored and not claimed yet. The only time it can be cancelled. |
| `broadcasting` | Claimed, and at least one item is still in progress: `queued`, `awaiting_approval` or `broadcasting`. |
| `confirmed` | Every item is `confirmed`. |
| `partial` | Every item is final, and some but not all are `confirmed`. |
| `failed` | Every item is final, and none is `confirmed`. |
| `cancelled` | Withdrawn before it was claimed. Every item is `cancelled` too. |

`abandoned` counts as not confirmed, so a Dispatch whose items are all `abandoned` reads `failed`. Check the items, where the difference shows. `awaiting_approval` counts as in progress, so a Dispatch waiting on Approvers reads `broadcasting`.

The engine stores only `queued`, `broadcasting` and `cancelled`. It works out `confirmed`, `partial` and `failed` from the items each time you read.

A Relay Dispatch's one status can be any item status except `awaiting_approval`, so a Relay Dispatch can read `abandoned` at the top level.

## `failed` and `abandoned` are different

`failed` means the payment did not happen and will not happen. Sending it again is safe.

`abandoned` means nobody knows yet. Two cases produce it:

- **A Base transaction that never got an answer.** After 15 minutes with no outcome, the engine stops waiting. With [Retry Policy](#retry-policy-and-stuck-transactions) on, it first tries higher fees, and abandons only once it cannot raise them any more. The transaction stays valid and may still be mined, so the engine keeps checking it at a low rate for a while and reports it if it lands.
- **A multisig Proposal nobody decided on by its deadline.** The error code is `APPROVAL_TIMEOUT`. An Approver may still approve it and someone else may execute it. The engine keeps reading the Proposal for 30 days after the deadline, and moves the item to `confirmed` or `failed` once if it sees an outcome. [Pay from a multisig](./guides/multisig.md#after-a-timeout) has the details.

A late outcome reaches you only through `GET /v1/dispatch/{id}` and the engine's logs.

Solana transactions are never `abandoned`. A Solana blockhash expires at a known block height, so the engine can prove a transaction can never land. It then sends a fresh one, up to 3 times, and after that the item is `failed`.

## `broadcasting` covers an unknown send

If the engine sends a transaction and the RPC times out, the transaction may or may not have reached the chain. The item stays `broadcasting`, and the engine checks the chain and, on Base, sends the same bytes again. It never reports `failed` for a send it cannot prove failed. An RPC `5xx` or a node that is behind counts as an unknown answer too.

While an item is `broadcasting`, its `transactionHash` can change:

- On Base with Retry Policy on, a fee bump replaces the transaction with a new one at the same nonce. `transactionHash` is the latest version until one lands. Then it is the one that landed, which may be the original.
- On Solana, a resubmission after expiry is a new transaction with a new hash.

## The Funding Check

Before the engine signs anything for a Managed Dispatch, it checks that the payer can afford it. A shortfall fails the affected items at once, with an error that says how much more is needed, instead of letting payment 312 of 500 fail on the chain.

The worker runs the check when it claims a batch of queued Dispatches, before it builds any transaction. It does not run when you call `POST /v1/dispatch`, so a `202` says nothing about the balance. Top up the Sender before you submit, or expect `INSUFFICIENT_FUNDS` on the items. [Read Sender balances before you send](./guides/sender-balances.md) shows how.

For each asset, the check adds up everything the claimed Dispatches need from each payer:

- **Payments.** Every `payment` item's amount, per asset.
- **Fees, on Solana.** The SOL for each transaction's fee, any priority fee, and the rent for every recipient token account the engine has to create.
- **The real payer.** Each amount is checked against whoever pays it. The Sender pays almost everything. A Bulk Call's ERC-20 items are paid from the aggregator contract's own balance, so they are checked against the aggregator.
- **Money already promised, for a Multisig Sender.** Open Proposals, Calls waiting to be proposed, and timed-out Proposals the engine still watches all hold back part of the balance. The check subtracts that `committed` amount first, so a second Dispatch cannot spend what the first is waiting to pay.

A `call` item is not counted, not even the `value` a Base call sends. The engine does not read what your encoded call spends, so make sure the Sender holds enough for your calls yourself. If the engine cannot read a balance at all, for example because the RPC is down, it fails the affected items rather than send them unchecked.

Items the balance can cover still go ahead, so a Dispatch with one unaffordable item can read `partial`. The check is a snapshot at claim time. If something else spends from the Sender between the check and the send, the chain can still refuse a transaction, and the item fails with `INSUFFICIENT_FUNDS` from the chain instead.

## Retry Policy and stuck transactions

A transaction that was sent but does not confirm is stuck. The engine always keeps trying to deliver it. Retry Policy decides one thing on top of that: whether the engine may pay more to get it through.

Retry Policy is off unless you turn it on. With it off, nothing about a Dispatch can cost more than what its transactions were signed with. Turn it on for one Dispatch with `"retryPolicy": true` in the request, or for every Dispatch that does not say with `DEFAULT_RETRY_POLICY=true` on the API. The value is fixed when the Dispatch is created. Changing the default later does not change Dispatches already stored. A Relay Dispatch has no Retry Policy, because the engine has no key to sign a replacement, so a Relay request that sets it is refused.

**On Base**, a transaction is stuck when it is still pending 60 seconds after its latest send (`BASE_STUCK_AFTER_MS`). Then:

- **Retry Policy off.** The engine sends the same signed bytes again. If the node already has them, that is fine. It keeps doing this until the transaction lands, or until 15 minutes pass with no answer and the item becomes `abandoned`.
- **Retry Policy on.** The engine signs a replacement at the same nonce with both fees raised by at least 15% (`BASE_FEE_BUMP_PERCENT`), up to 5 bumps per call (`BASE_MAX_FEE_BUMPS`), failed attempts included. Only one version can ever be mined, because they share a nonce. When it runs out of bumps, the latest version waits out the same 15-minute timeout.

Each bump goes through the Signer like any transaction, so a policy cap applies to it. A refused bump stops the bumping, and the engine keeps tracking the transaction it already has.

**On Solana** there is no fee bump, and Retry Policy does nothing. A Solana transaction carries a recent blockhash and is valid only until a known block height:

1. While the blockhash is valid, the engine resends the identical bytes.
2. Once the chain has passed that height, with a margin for a lagging RPC node, the transaction can never land. The engine builds a new transaction for the same calls with a fresh blockhash, signs it and sends it. The expired one was never charged, so this costs nothing extra.
3. After 3 resubmissions the item is `failed`.

An expired Relay Dispatch is `failed` at once, because the engine cannot re-sign it. To get through a congested Solana network, the operator sets a priority fee instead, with `SOLANA_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS`. It is off by default for the same reason Retry Policy is.

Sending the same bytes again is an attempt of the same transaction, and the timeline shows each one as `attempt`. Anything that changes the bytes, a fee bump or a fresh blockhash, is a new transaction with its own hash. [Track a Dispatch](./guides/track.md) shows how each appears.

## Cancelled

You can withdraw a Dispatch with [Cancel a Dispatch](./openapi.yaml#cancel-a-dispatch), or the console's **Cancel Dispatch** button, only while it is `queued`. Once the worker claims it, the answer is `409 ALREADY_CLAIMED`. A signed transaction cannot be safely unsent, and an open Proposal is the Approvers' to reject in Squads or Safe. You cancel a whole Dispatch, never a single item. `cancelled` is stored and final. [Cancel a Dispatch](./guides/cancel.md) walks through it.
