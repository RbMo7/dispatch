# Pay from a multisig

When the operator makes a Squads multisig on Solana or a Safe on Base the Sender, people approve every run of payments before money moves. You still call the same API. This guide shows what changes for your code: one more status, an `approval` block on each item, a deadline, and a timeout that is not a failure.

[Set up a multisig Sender](../self-hosting/multisig.md) is the operator's side: creating the multisig, the engine's key, and the page for Approvers.

## Two ways people approve the money

- **Treasury.** A multisig holds most of the funds and tops up an ordinary hot Sender. The engine never sees the multisig, so nothing in this guide applies. When the Sender runs short, the [Funding Check](../lifecycle.md#the-funding-check) fails the payments it cannot cover with `INSUFFICIENT_FUNDS`, and `chainDetail.short` is the exact top-up the Approvers send.
- **Multisig Sender.** The Sender is the multisig itself: the Squads vault, or the Safe. The engine proposes each run of payments, the Approvers vote in the Squads app or the Safe app, and the engine executes once enough of them approve. The rest of this guide is about this case.

| | Treasury | Multisig Sender |
| --- | --- | --- |
| Where the funds sit | Most in the multisig, a working balance in a hot Sender | All in the multisig |
| Who approves | M of N approve each top-up | M of N approve every payment run |
| Engine settings | None. The Sender is configured as usual. | `SOLANA_SENDER_MODE=multisig` or `BASE_SENDER_MODE=safe`, and more |
| A stolen Sender key loses | The working balance | Nothing, if the Signer's policy holds. The engine's key can only propose and execute. |
| Throughput | As fast as a plain Sender | One approval round per Proposal. On Base, one Proposal in flight per Safe at a time. |
| Failure when short | `INSUFFICIENT_FUNDS`, naming the top-up | `INSUFFICIENT_FUNDS`, naming which balance is short |

Choose a Treasury when you accept a hot wallet with a bounded balance and you want speed. Choose a Multisig Sender when no single key or host may move a payment run on its own. [List Senders](../openapi.yaml#list-senders) tells you which you have: `mode` is `squads` or `safe` for a Multisig Sender.

## 1. Send only transfers

A Multisig Sender proposes only native transfers and token transfers: SOL, SPL and Token-2022 on Solana, and ETH and the ERC-20 tokens in `BASE_KNOWN_TOKENS` on Base. `POST /v1/dispatch` checks every item before it stores anything. A `call` item the multisig cannot hold, or a `bulkCall`, is a `400` with `CHAIN_REJECTED` whose message names the item, such as `items[1]: …`. No Dispatch is stored, and the `Idempotency-Key` is not used up. Send unusual calls through a plain Sender.

## 2. Batch your payments into few Dispatches

The engine groups a Dispatch's payments into Proposals, and a Proposal never mixes Dispatches, so an Approver can check it against one caller's payment file. Every Proposal needs its own votes:

- **Squads** holds at most 12 transfers per Proposal, fewer when the transaction would pass Solana's 1,232-byte limit. The engine creates the Proposals one after another, and they can all be open at once, to be approved and executed in any order.
- **Safe** holds up to `BASE_SAFE_BUNDLE_LIMIT` payments per Proposal, 50 by default, in one MultiSend. A Safe's nonce is sequential, so the engine keeps one open Proposal per Safe and creates the next only when the previous one is resolved.

500 payments on Squads at 12 per Proposal are 42 Proposals, and with a threshold of 2 that is 84 votes. If you send a Dispatch per payment, you get a Proposal per payment. Send small payments together in fewer, larger Dispatches, or ask the operator for a Treasury and a hot Sender for that traffic.

## 3. Submit as usual

Submit with [Create a Dispatch](../openapi.yaml#create-a-dispatch), exactly as for a plain Sender. The answer is `202` with an id.

## 4. Read the approval while you wait

While the engine has not put a Call into a Proposal, the item is `queued`. On Base it also stays `queued`, with no `approval` block, while an earlier Proposal holds the Safe. Once the Call is in a Proposal, the item is `awaiting_approval`, with `transactionHash: null` because nothing has executed, and it carries an `approval` block. This example is an illustration, not a live run:

```json
{
  "type": "payment",
  "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
  "asset": "USDC",
  "decimals": 6,
  "amount": "15000000",
  "status": "awaiting_approval",
  "transactionHash": null,
  "error": null,
  "approval": {
    "state": "awaiting",
    "approvals": 1,
    "threshold": 2,
    "deadline": "2026-11-04T09:00:00.000Z",
    "expected": { "recipients": 12, "totals": [{ "asset": "USDC", "amount": "180000000" }] },
    "chainRef": { "kind": "squads", "multisig": "<multisig>", "proposal": "<proposal>", "transactionIndex": 42 }
  }
}
```

| Field | Means |
| --- | --- |
| `state` | `awaiting`: the Proposal has not reached its threshold. `approved`: it has, and is waiting out a time lock or being executed. `approved_after_deadline`: only on an `abandoned` item. The Proposal was approved after the deadline, and the engine will not execute it. |
| `approvals`, `threshold` | The votes so far, and the votes needed. |
| `deadline` | When the engine stops waiting. 72 hours from the Proposal's creation by default (`SOLANA_APPROVAL_DEADLINE_MS`, `BASE_APPROVAL_DEADLINE_MS`), one setting for the whole engine, with no per-request override. |
| `chainRef` | The multisig's own handle for the Proposal, to open it in the app: `{ "kind": "squads", "multisig", "proposal", "transactionIndex" }` or `{ "kind": "safe", "safe", "safeTxHash", "nonce" }`. |
| `expected` | What the engine says this Proposal pays: how many distinct recipients, and the total per asset in the smallest unit. Each Proposal of a large Dispatch carries its own share. |

`expected` helps an Approver notice a wrong file, but the same engine that wrote the Proposal wrote it, so it proves nothing about what the Proposal's bytes do. Do not show it to Approvers as a check. They compare the Proposal with their own record of the payments.

The `approval` block stays on the item after it is `confirmed`, `failed` or `abandoned`. The Dispatch reads `broadcasting` the whole time its items await approval: there is no top-level status for it. Poll these Dispatches every minute or so, not every few seconds.

## 5. Read the outcome

At the threshold, after any Squads time lock, the engine executes the Proposal. The items become `broadcasting`, then `confirmed` or `failed`, with `transactionHash` set to the transaction that executed it. On Solana the engine then closes finished Proposals to get their rent back.

A Proposal can also end in three other ways:

- **Rejected before its deadline.** An Approver rejects or cancels it, or it goes stale. The items are `failed` with `APPROVAL_REJECTED`, and are never retried.
- **Executed by someone else.** An Approver executes it from the app first. The items are `confirmed` with that transaction's hash.
- **Nobody decided by the deadline.** The items are `abandoned` with `APPROVAL_TIMEOUT`.

After the deadline the engine never executes the Proposal, even if it is approved a minute later. The check runs before every execute, so an approved Proposal still waiting out a Squads time lock when the deadline passes is abandoned too.

## After a timeout

`abandoned` with `APPROVAL_TIMEOUT` is not a failure. The Proposal is still open in the multisig, an Approver may still approve it, and someone else may still execute it. Its `error.chainDetail` is `{ "deadlineAt": "<ISO 8601>" }`.

The engine keeps reading a timed-out Proposal for 30 days after the timeout (`SOLANA_APPROVAL_REWATCH_WINDOW_MS`, `BASE_APPROVAL_REWATCH_WINDOW_MS`), and an item changes once, and only once, if it sees an outcome:

- **Someone executed it.** The item becomes `confirmed`, with the hash of that execution. The engine never sent it, so no engine-signed transaction stands behind it.
- **It was rejected, cancelled or went stale.** The item becomes `failed` with `APPROVAL_REJECTED`. On Base, a Safe nonce taken by a different transaction counts as rejected.
- **It was approved but nobody executed it.** The item stays `abandoned`, and `approval.state` reads `approved_after_deadline`. The engine still will not execute it. An operator executes or rejects it in the app.
- **The window ends.** The item stays `abandoned` for good, and a later execution goes unseen.

While the engine watches, the Proposal's amounts stay counted as `committed` in the Funding Check, so new Dispatches can be refused with `INSUFFICIENT_FUNDS`. Rejecting a dead Proposal in the app releases them at the next read.

Treat `APPROVAL_TIMEOUT` like any `abandoned` item. Check the multisig before you send the payment again, or it may happen twice. To make a timed-out Proposal dead, an Approver rejects it in the app. The engine cannot cancel it, and neither can [Cancel a Dispatch](./cancel.md).

## Follow a Proposal in the timeline

With `include=timeline`, a Multisig Sender's Dispatch adds four kinds of entry. [Track a Dispatch](./track.md#every-kind-of-entry) lists them all.

- `proposal_created`: the Proposal was written down, with its `proposalId`, `chainRef` and `items`.
- `proposal_approval`: the Approvers' decision as the engine last read it, with `state`, `approvals` and `threshold`. Its `at` is `null` while the Proposal is still open.
- `proposal_timed_out`: nobody decided by the deadline.
- `proposal_resolved`: the Proposal ended, with `outcome` `executed`, `rejected` or `failed`. A Proposal cancelled in Squads reads `rejected`.
