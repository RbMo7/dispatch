# Multisig: Treasury or Multisig Sender

This guide is for an operator who wants people to approve the money the engine moves. It covers two independent patterns, on Solana with Squads v4 and on Base with Safe:

- **Treasury.** A multisig holds most of the funds and tops up an ordinary hot Sender. No engine setting is involved.
- **Multisig Sender.** The Sender is the multisig. The engine proposes each bundle of payments, the Approvers vote in the multisig's app, and the engine executes once enough have approved.

[Multisig Sender and Treasury](./concepts/multisig-and-treasury.md) and [Proposals and approvals](./concepts/proposals.md) explain the ideas. This page helps you choose, has the page to hand your Approvers, and lists the behaviors to know before you rely on it. The setup runbooks are [Squads on Solana](./guides/squads.md) and [Safe on Base](./guides/safe.md).

Read [Set up the Signer](./signer.md) first. Every key in this guide lives behind the Signer, and the [mainnet checklist](./operations/mainnet-checklist.md) includes the multisig items. The decisions behind this feature are ADR-0049 to ADR-0054.

## What is built, and what is not

This guide describes what the code does. Batch proposals on Solana are **not built** (issue #91). Follow-up not done: human checks before mainnet (#96: the Squads app's labels and rent collector screen, Safe plan quotas, delegate removal, self-hosting, mainnet read-only facts). [After a timeout](#what-the-engine-does-and-does-not-do-after-a-timeout) covers what happens when nobody decides. Nothing here has been run on mainnet. The whole path (the API, the Coordinator, a real Signer enforcing the policy, and the chain) is proven end to end against Solana devnet (`RUN_SQUADS=1`, issue #78: approve, reject, timeout then a human's late execution, Funding Check, Signer policy) and against Base Sepolia with the hosted Safe Transaction Service (`RUN_SAFE=1`, issue #87: the same, plus the one-open-proposal queue and the stale-nonce guard). Both are opt-in, spend a little testnet funds, and are not part of CI (`docs/agents/`, ADR-0013).

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
2. Set up the Sender as an ordinary key on any Signer backend, with a policy, as in [Set up the Signer](./signer.md). Put its address in `SOLANA_SENDER_ADDRESS` or `BASE_SENDER_ADDRESS`, as usual. Do not set the Sender mode.
3. Move a working balance from the multisig to the Sender. The Approvers do this in the Squads or Safe app.
4. When a Dispatch finds the Sender short, the Funding Check fails the shortfall Calls with `INSUFFICIENT_FUNDS`. Its `chainDetail` is `{ "asset": "USDC", "short": "40" }`: `short` is the extra the Sender needs, in the asset's smallest unit. On Solana it includes the SOL for fees and for new token accounts (ADR-0043). The Approvers send that much, at least, and the caller sends the payments again with a **new** `Idempotency-Key`.

The engine never sees the Treasury. Size the working balance to the largest run you are willing to lose with the Sender key, and set the Sender's Signer policy caps to match.

## For Approvers

This section is for the people who vote. Send it to them.

You never touch the engine or the Signer. You hold your own key in your own wallet, and you vote in the Squads app or the Safe app. The engine's key is not an Approver on either chain, and it cannot vote.

### What you do

- **Squads (Solana).** Open the multisig in the Squads app. A proposal appears in its transaction list. Open it, check its instructions against your own record of the payments, then approve or reject. Whether the app decodes every instruction clearly for a given proposal was not checked for this guide, which is why the verifier below exists.
- **Safe (Base).** Open the Safe in the Safe app. The engine's proposal is queued in the Safe's pending transactions. Open it, check the decoded MultiSend against your own record, then confirm or reject. Confirming is a signature, with no gas. In the app, the proposal shows as proposed by **the owner who registered the engine as a delegate**, not by the engine: the service records the engine separately as `proposedByDelegate`, and the engine sets the origin to `Dispatch engine`.

### What the service tells you

The caller can read the proposal's state from `GET /v1/dispatch/:id` ([`GET /v1/dispatch/:id`](./api/get-dispatch.md#the-approval-block)). Each item that belongs to a proposal has an `approval` block:

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

Compare the proposal's decoded payments against **your own record**: the payment file the Dispatch was made from, or the invoice list, not anything the engine or the caller's system gave you after the fact. Do it in the app by eye, or run the independent verifier, which reads the chain and your file and shares no code with the engine ([`verifier/README.md`](../verifier/README.md)):

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
- **Re-watch (ADR-0053, #88).** The engine keeps reading the timed-out proposal for `*_APPROVAL_REWATCH_WINDOW_MS` (30 days by default, counted from the timeout): at the normal watch cadence for the first day, then hourly. It still never executes it. What it does when it sees something:
  - Executed by someone else: the Calls become `CONFIRMED`, with that transaction's hash, and the worker logs `late_execution_detected`. On Safe the service's `isExecuted` is cross-checked against the executing transaction's receipt (it must have succeeded and carry this Safe's `ExecutionSuccess` event for this `safeTxHash`). Without that proof nothing settles.
  - Rejected, cancelled or stale before approval (Safe: the nonce taken by a different transaction, so a superseded proposal is also caught): the Calls become `FAILED` with `APPROVAL_REJECTED`.
  - Approved but not executed: the Calls stay `ABANDONED`, `approval.state` reads `approved_after_deadline`, and the worker logs an error containing `approved_after_deadline` at most once an hour. Execute or reject it in the app.
  - The window ends: the Calls stay `ABANDONED`, the worker logs `rewatch_window_ended` once, and a later execution goes **unseen**. A proposal that cannot be read keeps being retried with backoff until then.
  - There is no push: the outcome reaches a caller only through `GET /v1/dispatch/:id` and the logs (no webhooks, ADR-0023).
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

[Troubleshooting](./operations/troubleshooting.md#multisig-sender) lists every multisig symptom with its cause and fix: a worker that will not start, `SIGNER_REFUSED` on a proposal, an item stuck in `awaiting_approval`, `GS013` and the rest.

## Mainnet checklist for a multisig

The items are in the [mainnet checklist](./operations/mainnet-checklist.md), next to the Signer's own. Clear them in addition to the rest of that list.
