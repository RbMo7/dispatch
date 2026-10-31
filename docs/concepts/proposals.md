# Proposals and approvals

A Proposal is one multisig transaction that the engine proposes for the Approvers to decide on. Only a [Multisig Sender](./multisig-and-treasury.md) has them. A Dispatch from a plain Sender never shows any of this.

## One Dispatch, one or more Proposals

A Proposal holds Calls from exactly one Dispatch, so an Approver can check it against that one caller's payment file ([ADR-0054](../adr/0054-multisig-approval-is-a-chain-handler-capability-and-a-proposal-never-mixes-dispatches.md)). A large Dispatch is split, in order, into as many Proposals as it needs:

- **Squads** holds at most 12 transfers per Proposal, fewer when the transaction would pass Solana's 1,232-byte limit. The Proposals are created one after another and can all be open at once. They are approved and executed independently, in any order.
- **Safe** holds up to `BASE_SAFE_BUNDLE_LIMIT` payments per Proposal, 50 by default, in one MultiSend. A Safe's nonce is sequential, so the engine keeps one open Proposal per Safe. The next is created only when the previous one is resolved ([ADR-0051](../adr/0051-a-safe-sender-is-proposed-by-a-delegate-and-executed-by-an-ordinary-key.md)).

Each Proposal needs its own votes. 500 payments on Squads at 12 per Proposal are 42 Proposals, and with a threshold of 2 that is 84 votes.

## The life of a Proposal

1. **Written down.** The engine records the Proposal before it sends anything, so a restart cannot lose it.
2. **Posted.** On Solana the member key creates the vault transaction and the proposal on chain. On Base the executor posts it to the Safe Transaction Service as a delegate.
3. **Waiting.** The items are `awaiting_approval`, with `transactionHash: null`, because nothing has executed. Each carries an `approval` block with the votes so far, the threshold, the deadline, and a `chainRef` to open it in the app.
4. **Approved.** At the threshold, the engine executes it (after any Squads time lock). The items become `broadcasting`, then `confirmed` or `failed`, with the hash of the transaction that executed it.
5. **Closed.** On Solana the engine closes finished Proposals to get their rent back.

A Proposal can also end in three other ways:

- **Rejected before its deadline.** An Approver rejects or cancels it, or it goes stale. The items are `failed` with `APPROVAL_REJECTED`, and are never retried.
- **Executed by someone else.** An Approver executes it from the app first. The items are `confirmed` with that transaction's hash.
- **Nobody decided by the deadline.** The items are `abandoned` with `APPROVAL_TIMEOUT`.

## The deadline

Every Proposal has a deadline, 72 hours after it was created by default (`SOLANA_APPROVAL_DEADLINE_MS`, `BASE_APPROVAL_DEADLINE_MS`). It is one setting for the whole engine, with no per-request override. After the deadline the engine **never executes** the Proposal, even if it is approved a minute later. The check runs before every execute, so an approved Proposal still waiting out a Squads time lock when the deadline passes is abandoned too. Set the deadline longer than your Approvers' voting time plus any time lock.

## After a timeout

`abandoned` with `APPROVAL_TIMEOUT` is not a failure ([ADR-0053](../adr/0053-a-multisig-proposal-nobody-decided-on-is-abandoned-and-watched.md)). The Proposal is still open in the multisig. An Approver may still approve it, and someone else may still execute it.

The engine keeps reading a timed-out Proposal for 30 days after the timeout (`SOLANA_APPROVAL_REWATCH_WINDOW_MS`, `BASE_APPROVAL_REWATCH_WINDOW_MS`), and an item changes once if it sees an outcome:

- **Someone executed it.** The item becomes `confirmed`, with the hash of that execution.
- **It was rejected, cancelled or went stale.** The item becomes `failed` with `APPROVAL_REJECTED`.
- **It was approved but nobody executed it.** The item stays `abandoned`, and `approval.state` reads `approved_after_deadline`. The engine still will not execute it. An operator executes or rejects it in the app.
- **The window ends.** The item stays `abandoned` for good, and a later execution goes unseen.

While the engine watches, the Proposal's amounts stay counted as `committed` in the [Funding Check](./funding-check.md). Rejecting a dead Proposal in the app releases them.

Treat `APPROVAL_TIMEOUT` like any `abandoned` item. Check the multisig before you send the payment again, or it may happen twice. To make a timed-out Proposal dead, an Approver rejects it in the app. The engine cannot cancel it, and `POST /v1/dispatch/:id/cancel` cannot either.

## Reading a Proposal from the API

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

[`GET /v1/dispatch/:id`](../api/get-dispatch.md#the-approval-block) defines each field. The [timeline](../api/get-dispatch.md#see-every-step-with-includetimeline) adds `proposal_created`, `proposal_approval`, `proposal_timed_out` and `proposal_resolved` entries.
