# Read a Dispatch

## `GET /v1/dispatch/:id`

Returns one Dispatch, Managed or Relay, in its current state. Needs the `Authorization` header. Query parameters:

| Parameter | Means |
| --- | --- |
| `include=timeline` | Adds a `timeline` array ([below](#see-every-step-with-includetimeline)). Without it, or with any other `include` value, the body is exactly as described here. |

An id that does not exist, or is not a UUID, is `404 { "error": "not found" }`.

```sh
curl -s "$DISPATCH_URL/v1/dispatch/651d094d-00de-4dc6-a7c4-0ec2dc98b610" \
  -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "651d094d-00de-4dc6-a7c4-0ec2dc98b610",
  "mode": "managed",
  "status": "partial",
  "items": [
    {
      "type": "payment",
      "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "asset": "ETH",
      "decimals": 18,
      "amount": "50000000000000",
      "status": "confirmed",
      "transactionHash": "0x1bc49343d87853d0d0a00f52edede50fc09562d4346b19d6d9d9a728f11bf64a",
      "error": null
    },
    {
      "type": "payment",
      "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "asset": "USDC",
      "decimals": 6,
      "amount": "40000000",
      "status": "failed",
      "transactionHash": null,
      "error": {
        "code": "INSUFFICIENT_FUNDS",
        "message": "insufficient USDC balance",
        "chainDetail": { "asset": "USDC", "short": "40000000" }
      }
    }
  ]
}
```

## A Managed Dispatch

| Field | Means |
| --- | --- |
| `dispatchId` | The id `POST /v1/dispatch` returned |
| `mode` | `"managed"` |
| `status` | `queued`, `broadcasting`, `confirmed`, `failed`, `partial` or `cancelled` |
| `items` | One entry per item, in the order the request listed them |

Every response, Managed or Relay, has a top-level `mode`, so a caller can tell which shape it is reading from the body alone ([ADR-0031](../adr/0031-relay-dispatch-shares-the-endpoint-gets-its-own-domain-type.md)).

### Items

Each item starts with what the caller asked for:

- A **`payment`** item repeats `type`, `recipient`, `asset`, `decimals` and `amount`. `amount` is the integer string the caller sent, in the asset's smallest unit. `decimals` is how many places that unit sits below one whole asset, from the engine's config: 9 for `SOL`, 18 for `ETH`, and what `SOLANA_KNOWN_TOKENS` or `BASE_KNOWN_TOKENS` says for a token. It is left out when the stored asset is no longer configured.
- A **`call`** item gives its `type` and its target, `to` on `base` or `programId` on `solana`, and leaves out the rest of the Call (`data`, `value`, `accounts`).

A Bulk Call or Multisig Sender item reads the same way. These are the items as submitted, not the transactions that carried them.

Then each item adds:

| Field | Means |
| --- | --- |
| `status` | `queued`, `awaiting_approval`, `broadcasting`, `confirmed`, `failed`, `abandoned` or `cancelled` |
| `transactionHash` | The transaction that carries the item, or `null` |
| `error` | `null`, or `{ code, message, chainDetail? }` ([error codes](../api.md#error-codes)) |
| `approval` | Only for an item in a multisig Proposal ([below](#the-approval-block)) |

`error` follows ADR-0010's structured shape exactly, never a bare string. A `failed` item's `transactionHash` is `null` when it failed before anything was signed, as in the example above, and set when the transaction was signed and then refused: every transaction is written down, hash included, before it is sent ([ADR-0041](../adr/0041-transactions-are-noted-before-they-are-sent.md)).

### Item statuses

The item status has its own vocabulary, separate from the top-level one. It adds `abandoned`, a terminal state distinct from `failed` ([ADR-0004](../adr/0004-abandoned-is-distinct-from-failed.md)), and `awaiting_approval` for a Multisig Sender. It never reports `partial`, which only describes the whole Dispatch. [Statuses](../concepts/statuses.md) says what each means for your code.

- `queued`: the Call has not reached a transaction yet, and `transactionHash` is `null`. For a Multisig Sender it also means claimed but not yet in a Proposal.
- `broadcasting`: the transaction is unresolved. That includes a send whose outcome is unknown, such as a timeout. The transaction may have reached the chain, so it is checked, and on Base rebroadcast, rather than reported `failed`. It becomes `abandoned` only after the chain's timeout (15 minutes on Base) with no answer ([ADR-0041](../adr/0041-transactions-are-noted-before-they-are-sent.md), [ADR-0004](../adr/0004-abandoned-is-distinct-from-failed.md)).
- On Solana, an item whose transaction expired without landing is resubmitted with a fresh blockhash, up to 3 times, whatever `retryPolicy` says. The expired one was never charged, so this costs nothing extra ([ADR-0042](../adr/0042-solana-expiry-is-a-chain-status-and-the-coordinator-resubmits.md)). Its `transactionHash` then changes to the resubmission's. After the third it is `failed`, as is an expired Relay Dispatch, which the engine has no key to re-sign.
- With `retryPolicy: true`, a stuck Base item may be fee-bumped: replaced by a new transaction at the same nonce with higher fees ([ADR-0037](../adr/0037-fee-bump-is-coordinator-driven-via-an-optional-handler-method.md)). While that is in progress, `transactionHash` is the latest version and can change between polls. Once one version lands, `transactionHash` is the one that landed, which may be the original.

### The top-level status

The top-level `status` is worked out from the items. The engine stores only `queued` and `broadcasting` (the worker's claim, [ADR-0009](../adr/0009-api-service-plus-worker-sharing-a-db-outbox.md)) and `cancelled`. It computes `confirmed`, `failed` and `partial` each time you read:

- `confirmed` when every item is `confirmed`,
- `failed` when every item is final and none is `confirmed`,
- `partial` when every item is final and some, but not all, are `confirmed`.

An `abandoned` item counts as not confirmed, the same as `failed`. An `awaiting_approval` item counts as still in progress, so the top-level `status` stays `broadcasting` while Calls await approval. There is no top-level status for it.

## A Relay Dispatch

A Relay Dispatch is one transaction, not a batch, so its status sits at the top level instead of in a single-item array ([ADR-0031](../adr/0031-relay-dispatch-shares-the-endpoint-gets-its-own-domain-type.md)). It uses the item status vocabulary: `queued`, `broadcasting`, `confirmed`, `failed`, `abandoned` or `cancelled`.

```sh
curl -s "$DISPATCH_URL/v1/dispatch/4ecfe1aa-852d-4ef9-91f2-c78fb1690b75" \
  -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "4ecfe1aa-852d-4ef9-91f2-c78fb1690b75",
  "mode": "relay",
  "status": "confirmed",
  "transactionHash": "0x3e28307d8fae837fc7f8c54906f0ba7c7d737dcaf6c628b9f2d6c4158398566c",
  "error": null
}
```

## See every step with `?include=timeline`

`?include=timeline` adds a `timeline` array to the same body, Managed or Relay: what happened to the Dispatch, oldest first, rebuilt from the timestamps the engine already keeps. There is no separate event log ([ADR-0014](../adr/0014-no-premature-structural-infra.md)).

This is the Dispatch above. The USDC item failed the Funding Check, and the ETH item was signed, sent and confirmed:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/651d094d-00de-4dc6-a7c4-0ec2dc98b610?include=timeline" \
  -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "651d094d-00de-4dc6-a7c4-0ec2dc98b610",
  "mode": "managed",
  "status": "partial",
  "items": [
    {
      "type": "payment",
      "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "asset": "ETH",
      "decimals": 18,
      "amount": "50000000000000",
      "status": "confirmed",
      "transactionHash": "0x1bc49343…f64a",
      "error": null
    },
    {
      "type": "payment",
      "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "asset": "USDC",
      "decimals": 6,
      "amount": "40000000",
      "status": "failed",
      "transactionHash": null,
      "error": { "code": "INSUFFICIENT_FUNDS", "message": "insufficient USDC balance", "chainDetail": { "asset": "USDC", "short": "40000000" } }
    }
  ],
  "timeline": [
    { "kind": "created", "at": "2026-10-31T18:48:28.001Z" },
    {
      "kind": "failed",
      "at": "2026-10-31T18:48:30.906Z",
      "hash": null,
      "items": [1],
      "error": { "code": "INSUFFICIENT_FUNDS", "message": "insufficient USDC balance", "chainDetail": { "asset": "USDC", "short": "40000000" } }
    },
    { "kind": "claimed", "at": "2026-10-31T18:48:32.275Z" },
    { "kind": "written", "at": "2026-10-31T18:48:32.298Z", "hash": "0x1bc49343…f64a", "items": [0], "replaces": null },
    { "kind": "sent", "at": "2026-10-31T18:48:32.625Z", "hash": "0x1bc49343…f64a", "items": [0] },
    { "kind": "confirmed", "at": "2026-10-31T18:48:40.138Z", "hash": "0x1bc49343…f64a", "items": [0] }
  ]
}
```

`claimed` comes after the `failed` entry here because the worker re-stamps its claim as it works through a Dispatch.

Every entry has `at` (ISO 8601) and `kind`. `items` are the positions of the Calls an entry is about, several when one transaction carries a bundle. A Relay Dispatch's one transaction is item `0`. `hash` names the transaction version.

| `kind` | When | Extra fields |
| --- | --- | --- |
| `created` | `POST /v1/dispatch` stored it | |
| `claimed` | The worker last claimed it. A large Dispatch re-stamps this as it sends, so it can come after its first transactions. | |
| `cancelled` | It was [cancelled](./cancel-dispatch.md) | |
| `written` | A transaction version was signed and written down, before it was sent ([ADR-0041](../adr/0041-transactions-are-noted-before-they-are-sent.md)) | `hash`, `items`, `replaces` (the hash it replaced, or `null`) |
| `sent` | The node accepted it. Only shown while the version has no `attempt`, because a resend overwrites this moment. | `hash`, `items` |
| `attempt` | The same bytes were sent again. `error` is the node's answer if it refused. | `hash`, `items`, `error` |
| `replaced` | A newer version took its place: a fee bump ([ADR-0037](../adr/0037-fee-bump-is-coordinator-driven-via-an-optional-handler-method.md)). It may still be the one that lands. | `hash`, `items`, `by` |
| `dropped` | It can never land: a newer version replaced it after expiry ([ADR-0042](../adr/0042-solana-expiry-is-a-chain-status-and-the-coordinator-resubmits.md)), or another version settled the Call | `hash`, `items`, `by` (or `null`) |
| `confirmed`, `failed`, `abandoned` | Its outcome. A `failed` entry with `hash: null` failed before anything was signed. | `hash`, `items`, and `error` for `failed` and `abandoned` |
| `proposal_created` | A Multisig Sender's Proposal was written down | `proposalId`, `chainRef`, `items` |
| `proposal_approval` | The Approvers' decision, as the engine last read it. `at` is when the engine acted on it (wrote the execute, or the Proposal timed out or was resolved), and `null` while the Proposal is still open. `null` entries come last. | `proposalId`, `state`, `approvals`, `threshold` |
| `proposal_timed_out` | Nobody decided by the deadline ([ADR-0053](../adr/0053-a-multisig-proposal-nobody-decided-on-is-abandoned-and-watched.md)) | `proposalId` |
| `proposal_resolved` | The Proposal ended. A Proposal cancelled in Squads reads `rejected`, because the engine records it as `APPROVAL_REJECTED`, like a rejection. | `proposalId`, `outcome`: `executed`, `rejected` or `failed` |

A fee-bumped Base item shows each version. This sequence is an illustration with shortened hashes, not a live run:

```json
"timeline": [
  { "at": "2026-10-31T10:00:00.000Z", "kind": "created" },
  { "at": "2026-10-31T10:00:01.200Z", "kind": "claimed" },
  { "at": "2026-10-31T10:00:01.900Z", "kind": "written", "hash": "0xaa…", "items": [0], "replaces": null },
  { "at": "2026-10-31T10:01:02.000Z", "kind": "attempt", "hash": "0xaa…", "items": [0], "error": null },
  { "at": "2026-10-31T10:02:03.000Z", "kind": "written", "hash": "0xbb…", "items": [0], "replaces": "0xaa…" },
  { "at": "2026-10-31T10:02:03.000Z", "kind": "replaced", "hash": "0xaa…", "items": [0], "by": "0xbb…" },
  { "at": "2026-10-31T10:02:03.400Z", "kind": "sent", "hash": "0xbb…", "items": [0] },
  { "at": "2026-10-31T10:02:20.000Z", "kind": "confirmed", "hash": "0xbb…", "items": [0] },
  { "at": "2026-10-31T10:02:20.000Z", "kind": "dropped", "hash": "0xaa…", "items": [0], "by": "0xbb…" }
]
```

The first version was resent once (`attempt`), replaced by a higher-fee version a minute later, and the replacement confirmed, which dropped the original.

## Multisig approval

This section applies only to a [Multisig Sender](../concepts/multisig-and-treasury.md), a Sender whose address is a multisig wallet ([ADR-0049](../adr/0049-the-engine-proposes-and-executes-multisig-transactions-but-never-approves.md)). Its Calls are not signed and sent one by one. The engine groups them into a Proposal for the multisig's Approvers to decide on, then executes it once approved. A Proposal holds Calls from exactly one Dispatch ([ADR-0054](../adr/0054-multisig-approval-is-a-chain-handler-capability-and-a-proposal-never-mixes-dispatches.md)), so a large Dispatch may become several Proposals. A Dispatch that does not use a Multisig Sender never shows any of this.

How an item moves:

- While the engine has not yet put a Call into a Proposal, the item is `queued`.
- Once it is in one, the item is `awaiting_approval`, with `transactionHash: null`. Nothing has been executed, so there is no hash.
- When the Proposal is approved and the engine executes it, the item becomes `broadcasting`, then `confirmed` or `failed` as usual, with `transactionHash` set to the transaction that executed it.
- If someone else executes the Proposal **before** its deadline, the item becomes `confirmed` with that executor's hash.
- If someone else executes it **after** the deadline, the engine still sees it during the re-watch window, and the item becomes `confirmed` ([below](#after-a-timeout)).
- A Safe Sender also leaves a Dispatch's items `queued`, with no `approval` block, while an earlier Proposal for the same Safe is open, because a Safe holds one open Proposal at a time ([ADR-0051](../adr/0051-a-safe-sender-is-proposed-by-a-delegate-and-executed-by-an-ordinary-key.md)).

### The approval block

An item whose Call belongs to a Proposal carries an `approval` block. It is present whenever the Call belongs to a Proposal, including after the item is `abandoned`, `confirmed` or `failed`, and absent otherwise. This example is an illustration, not a live run:

```json
{
  "type": "payment",
  "recipient": "<address>",
  "asset": "USDC",
  "amount": "15",
  "status": "awaiting_approval",
  "transactionHash": null,
  "error": null,
  "approval": {
    "state": "awaiting",
    "approvals": 1,
    "threshold": 3,
    "deadline": "2026-10-24T12:00:00.000Z",
    "expected": { "recipients": 2, "totals": [{ "asset": "USDC", "amount": "30" }] },
    "chainRef": { "kind": "squads", "multisig": "<address>", "proposal": "<address>", "transactionIndex": 4 }
  }
}
```

| Field | Means |
| --- | --- |
| `state` | `awaiting`, `approved` or `approved_after_deadline`. `awaiting`: the Proposal has not reached its threshold. `approved`: it has, and is waiting out a time lock or being executed. `approved_after_deadline`: only on an `abandoned` item, approved after the deadline, and the engine will not execute it. During the re-watch window `state` follows what the engine last read. |
| `approvals`, `threshold` | The votes so far and the votes needed |
| `deadline` | When the engine stops waiting (ISO 8601). 72 hours from the Proposal's creation by default (`SOLANA_APPROVAL_DEADLINE_MS`, `BASE_APPROVAL_DEADLINE_MS`). After it the item is `abandoned` with `APPROVAL_TIMEOUT`, and the engine never executes the Proposal, even if it is approved later. |
| `chainRef` | The chain's own handle for the Proposal, to open it in the multisig's app: `{ "kind": "squads", "multisig", "proposal", "transactionIndex" }` or `{ "kind": "safe", "safe", "safeTxHash", "nonce" }` |
| `expected` | What this Proposal should pay out, built from this Dispatch's own items: how many distinct recipients, and the total per asset in the smallest unit. A mistake-catcher, not a control. It lets an Approver notice a wrong file, but the same engine that wrote the Proposal wrote it, so it proves nothing about what the Proposal's bytes really do. The independent verifier (`verifier/`, #89) checks that. |

### After a timeout

An `abandoned` item with `APPROVAL_TIMEOUT` is not a failure. An Approver may still approve it and someone else execute it. Check before sending again, or the payment may happen twice. A late outcome reaches a caller only through `GET` and the logs, and after the window nothing is seen.

An `error` for these codes carries `chainDetail`: `{ "deadlineAt": "<ISO 8601>" }` for `APPROVAL_TIMEOUT`, and `{ "status": "rejected" | "cancelled" | "stale" }` for an `APPROVAL_REJECTED` raised by the watch. A Safe whose nonce was taken by another transaction reports `rejected`.

The engine keeps reading a timed-out Proposal for a re-watch window, 30 days after it timed out by default (`SOLANA_APPROVAL_REWATCH_WINDOW_MS`, `BASE_APPROVAL_REWATCH_WINDOW_MS`). An `abandoned` item can then change once, and only once:

- Someone else executed the Proposal. The item becomes `confirmed`, with `transactionHash` set to the transaction that executed it. The engine never sent it, so there is no engine-signed transaction behind it.
- The Proposal was rejected or cancelled (Squads), made stale before approval, or lost its Safe nonce to a different transaction. The item becomes `failed` with `APPROVAL_REJECTED`.
- It was approved but not executed. It stays `abandoned`, and `approval.state` reads `approved_after_deadline`. The engine never executes it. An operator executes or rejects it in the multisig's app.
- The window ends with no decision. It stays `abandoned` for good, and a later execution goes unseen.
