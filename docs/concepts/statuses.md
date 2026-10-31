# Statuses

A Managed Dispatch has a status, and so does each of its items. The item status is the one to act on. The Dispatch status is a summary for lists and dashboards. A Relay Dispatch is one transaction, so it has one status, from the item list below.

## Item statuses

| Status | What happened | Final | What your code does |
| --- | --- | --- | --- |
| `queued` | Stored, not yet in a transaction. For a Multisig Sender: claimed, but not yet in a Proposal, or waiting for an earlier Proposal on the same Safe. | No | Wait. |
| `awaiting_approval` | In a multisig Proposal that the Approvers have not yet decided. Only for a Multisig Sender. | No | Wait. The `approval` block shows the votes and the deadline. |
| `broadcasting` | Signed and written down, and sent or about to be sent. Includes a send whose outcome is not known yet. | No | Wait. Do not resend. The transaction may land. |
| `confirmed` | Landed on the chain and succeeded. | Yes | Record `transactionHash`. |
| `failed` | Definitely did not happen: refused before signing, refused by the Signer or the chain, or reverted. | Yes | Read `error.code`. Fix the cause and send again with a new `Idempotency-Key`. |
| `abandoned` | The engine stopped waiting without a definite answer. The transaction or Proposal may still land. | Yes, for the engine | Check the chain or the multisig before you send again, or the payment may happen twice. |
| `cancelled` | An operator withdrew the Dispatch before the engine claimed it. Nothing was signed or sent. | Yes | Send again with a new `Idempotency-Key` if you still want it. |

## `failed` and `abandoned` are different

`failed` means the payment did not happen and will not happen ([ADR-0004](../adr/0004-abandoned-is-distinct-from-failed.md)). Retrying is safe.

`abandoned` means nobody knows yet. Two cases produce it:

- **A Base transaction that never got an answer.** After 15 minutes with no outcome, the engine stops waiting. With [Retry Policy](./retry-policy.md) on, it first tries higher fees, and only abandons once it cannot bump any more. The transaction stays valid and may still be mined, so the engine keeps checking it at a low rate for a while and reports it if it lands.
- **A multisig Proposal nobody decided on by its deadline.** The error code is `APPROVAL_TIMEOUT`. An Approver may still approve it and someone else may execute it. The engine keeps reading the Proposal for 30 days after the deadline and moves the item to `confirmed` or `failed` once if it sees an outcome ([ADR-0053](../adr/0053-a-multisig-proposal-nobody-decided-on-is-abandoned-and-watched.md)).

A late outcome reaches you only through `GET /v1/dispatch/:id` and the engine's logs. There are no webhooks.

Solana transactions are never `abandoned`. A Solana blockhash expires at a known block height, so the engine can prove a transaction can never land. It then sends a fresh one, up to 3 times, and after that the item is `failed` ([ADR-0030](../adr/0030-solana-provable-expiry-resolves-to-failed-not-abandoned.md), [ADR-0042](../adr/0042-solana-expiry-is-a-chain-status-and-the-coordinator-resubmits.md)).

## `broadcasting` covers an unknown send

If the engine sends a transaction and the RPC times out, the transaction may or may not have reached the chain. The item stays `broadcasting`, and the engine checks the chain and, on Base, sends the same bytes again. It never reports `failed` for a send it cannot prove failed ([ADR-0041](../adr/0041-transactions-are-noted-before-they-are-sent.md)).

While an item is `broadcasting`, `transactionHash` can change:

- On Base with Retry Policy on, a fee bump replaces the transaction with a new one at the same nonce. `transactionHash` is the latest version until one lands, and then it is the one that landed, which may be the original.
- On Solana, a resubmission after expiry is a new transaction with a new hash.

## Dispatch statuses

The top-level `status` of a Managed Dispatch is one of `queued`, `broadcasting`, `confirmed`, `failed`, `partial` and `cancelled`.

| Status | Means |
| --- | --- |
| `queued` | Stored and not claimed by the worker yet. This is the only time it can be cancelled. |
| `broadcasting` | Claimed, and at least one item is still in progress (`queued`, `awaiting_approval` or `broadcasting`). |
| `confirmed` | Every item is `confirmed`. |
| `partial` | Every item is final, and some but not all are `confirmed`. |
| `failed` | Every item is final, and none is `confirmed`. |
| `cancelled` | Withdrawn before it was claimed. Every item is `cancelled` too. |

`abandoned` counts as not confirmed here, so a Dispatch whose items are all `abandoned` reads `failed`. Check the items, where the difference shows. `awaiting_approval` counts as in progress, so a Dispatch waiting on Approvers reads `broadcasting`.

The engine stores only `queued`, `broadcasting` and `cancelled`. It works out `confirmed`, `partial` and `failed` from the items each time you read.

A Relay Dispatch's single status can be any item status except `awaiting_approval`, so a Relay Dispatch can read `abandoned` at the top level.

## Cancelled

An operator can withdraw a Dispatch with `POST /v1/dispatch/:id/cancel`, or the console's **Cancel Dispatch** button, only while it is `queued` ([ADR-0056](../adr/0056-a-dispatch-can-be-cancelled-only-before-it-is-claimed.md)). Once the worker claims it, the answer is `409 ALREADY_CLAIMED`. A signed transaction cannot be safely unsent, and an open Proposal is the Approvers' to reject in Squads or Safe. You cancel a whole Dispatch, never a single item.

`cancelled` is stored and final. Sending the same `Idempotency-Key` again returns the cancelled Dispatch and creates nothing.

## A polling loop

Poll until the top-level status is final, then act on each item:

```js
async function waitForDispatch(id) {
  for (;;) {
    const response = await fetch(`${process.env.DISPATCH_URL}/v1/dispatch/${id}`, {
      headers: { Authorization: `Bearer ${process.env.DISPATCH_TOKEN}` },
    });
    const dispatch = await response.json();
    if (!['queued', 'broadcasting'].includes(dispatch.status)) return dispatch;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
```

A few seconds between polls is plenty. Confirmation takes seconds on both chains, and a Multisig Sender can wait hours for votes, so back off further for those.
