# Track a Dispatch to confirmation and read its timeline

This guide follows one Dispatch from the moment you submit it until both of its payments confirm, then reads its timeline: every step the engine took, with times. The example pays two recipients on Solana devnet.

## 1. Submit the Dispatch

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: payout-2026-11-01-0193" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "solana",
    "items": [
      { "type": "payment", "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2", "asset": "SOL", "amount": "1250000" },
      { "type": "payment", "recipient": "HUJCp4QWFAtmTa6oEk4gXw5r2fuCah4FHn8c12QBv9KB", "asset": "SOL", "amount": "3400000" }
    ]
  }'
```

```json
{ "dispatchId": "ec4a9228-b427-4f4e-9792-44ab1b8fcbd6", "status": "queued" }
```

## 2. Poll it with its timeline

Ask for the Dispatch with `include=timeline`:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID?include=timeline" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

Before the worker claims it, every item is `queued` and the timeline has one entry. This is a real answer from a moment when the worker was stopped:

```json
{
  "dispatchId": "ec4a9228-b427-4f4e-9792-44ab1b8fcbd6",
  "mode": "managed",
  "chain": "solana",
  "createdAt": "2026-11-01T02:13:35.704Z",
  "status": "queued",
  "items": [
    {
      "type": "payment",
      "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
      "asset": "SOL",
      "decimals": 9,
      "amount": "1250000",
      "status": "queued",
      "transactionHash": null,
      "error": null
    },
    {
      "type": "payment",
      "recipient": "HUJCp4QWFAtmTa6oEk4gXw5r2fuCah4FHn8c12QBv9KB",
      "asset": "SOL",
      "decimals": 9,
      "amount": "3400000",
      "status": "queued",
      "transactionHash": null,
      "error": null
    }
  ],
  "timeline": [{ "kind": "created", "at": "2026-11-01T02:13:35.704Z" }]
}
```

Poll every few seconds. [Polling for results](../polling.md) has a loop that stops when the Dispatch is final.

## 3. Read the timeline

Once the worker ran, the same request returns both items `confirmed`, and a timeline of five entries:

```json
"timeline": [
  { "kind": "created", "at": "2026-11-01T02:13:35.704Z" },
  { "kind": "claimed", "at": "2026-11-01T02:13:48.803Z" },
  { "kind": "written", "at": "2026-11-01T02:13:49.345Z", "hash": "5gfGwrcSAxoQn1a4o2uwh3VGQSvccmQ47CyFfE7FGWsfT4HH5DVD9uzD7pcDMXGXyHJBEpM2DYgeu5AokZ1nvzG9", "items": [0, 1], "replaces": null },
  { "kind": "sent", "at": "2026-11-01T02:13:51.650Z", "hash": "5gfGwrcSAxoQn1a4o2uwh3VGQSvccmQ47CyFfE7FGWsfT4HH5DVD9uzD7pcDMXGXyHJBEpM2DYgeu5AokZ1nvzG9", "items": [0, 1] },
  { "kind": "confirmed", "at": "2026-11-01T02:13:52.971Z", "hash": "5gfGwrcSAxoQn1a4o2uwh3VGQSvccmQ47CyFfE7FGWsfT4HH5DVD9uzD7pcDMXGXyHJBEpM2DYgeu5AokZ1nvzG9", "items": [0, 1] }
]
```

Read it top to bottom:

1. `created`: the API stored the Dispatch.
2. `claimed`: the worker claimed it 13 seconds later, because it was restarted. A running worker claims within a few seconds.
3. `written`: one signed transaction carrying items 0 and 1 was written down, before it was sent. On Solana the engine packs several payments into one transaction.
4. `sent`: the node accepted it 2.3 seconds later.
5. `confirmed`: the chain confirmed it 1.3 seconds after that.

Both items carry the same `transactionHash`. Open it in an explorer: `https://explorer.solana.com/tx/<transactionHash>?cluster=devnet`, or on Base Sepolia `https://sepolia.basescan.org/tx/<transactionHash>`.

## When an item fails before signing

The timeline of [the batch in Send a batch of payments](./send-payments.md) shows a `failed` entry with `hash: null`: the Funding Check failed the USDC item before anything was signed. Its `claimed` entry comes after the `failed` one, because the worker re-stamps its claim as it works through a Dispatch.

```json
"timeline": [
  { "kind": "created", "at": "2026-11-01T02:12:17.619Z" },
  {
    "kind": "failed",
    "at": "2026-11-01T02:12:18.695Z",
    "hash": null,
    "items": [1],
    "error": { "code": "INSUFFICIENT_FUNDS", "message": "insufficient USDC balance", "chainDetail": { "asset": "USDC", "short": "40000000" } }
  },
  { "kind": "claimed", "at": "2026-11-01T02:12:22.042Z" },
  { "kind": "written", "at": "2026-11-01T02:12:22.050Z", "hash": "0x7e00aec4eafe72c4c852ff1517ddc1492b4581f117e9a9bbd88602f674735896", "items": [0], "replaces": null },
  { "kind": "sent", "at": "2026-11-01T02:12:22.320Z", "hash": "0x7e00aec4eafe72c4c852ff1517ddc1492b4581f117e9a9bbd88602f674735896", "items": [0] },
  { "kind": "confirmed", "at": "2026-11-01T02:12:27.324Z", "hash": "0x7e00aec4eafe72c4c852ff1517ddc1492b4581f117e9a9bbd88602f674735896", "items": [0] }
]
```

## When a transaction is replaced

A fee bump on Base, or a resubmission after a Solana blockhash expired, makes a new transaction with a new hash. The timeline shows every version. This sequence is an illustration with shortened hashes, not a live run:

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

The first version was resent once (`attempt`), replaced by a higher-fee version a minute later, and the replacement confirmed, which dropped the original. While this happens, the item's `transactionHash` is the latest version, and it can change between polls. Once a version lands, `transactionHash` is the one that landed, which may be the original. [Retry Policy and stuck transactions](../lifecycle.md#retry-policy-and-stuck-transactions) explains when the engine does this.

## Every kind of entry

Every entry has `at`, an ISO 8601 time, and `kind`. `items` are the positions of the items an entry is about, several when one transaction carries a bundle. A Relay Dispatch's one transaction is item `0`. `hash` names one version of a transaction. The timeline is rebuilt from times the engine already stores, oldest first.

| `kind` | When | Extra fields |
| --- | --- | --- |
| `created` | `POST /v1/dispatch` stored it. | |
| `claimed` | The worker last claimed it. A large Dispatch re-stamps this as it sends, so it can come after its first transactions. | |
| `cancelled` | It was [cancelled](./cancel.md). | |
| `written` | A transaction version was signed and written down, before it was sent. | `hash`, `items`, `replaces`: the hash it replaced, or `null` |
| `sent` | The node accepted it. Shown only while the version has no `attempt`, because a resend overwrites this moment. | `hash`, `items` |
| `attempt` | The same bytes were sent again. `error` is the node's answer if it refused. | `hash`, `items`, `error` |
| `replaced` | A newer version took its place: a fee bump. It may still be the one that lands. | `hash`, `items`, `by` |
| `dropped` | It can never land: a newer version replaced it after expiry, or another version settled the item. | `hash`, `items`, `by` or `null` |
| `confirmed`, `failed`, `abandoned` | Its outcome. A `failed` entry with `hash: null` failed before anything was signed. | `hash`, `items`, and `error` for `failed` and `abandoned` |
| `proposal_created` | A Multisig Sender's Proposal was written down. | `proposalId`, `chainRef`, `items` |
| `proposal_approval` | The Approvers' decision, as the engine last read it. `at` is when the engine acted on it: it wrote the execute, or the Proposal timed out or was resolved. It is `null` while the Proposal is still open, and `null` entries come last. | `proposalId`, `state`, `approvals`, `threshold` |
| `proposal_timed_out` | Nobody decided by the deadline. | `proposalId` |
| `proposal_resolved` | The Proposal ended. A Proposal cancelled in Squads reads `rejected`, because the engine records it as `APPROVAL_REJECTED`. | `proposalId`, `outcome`: `executed`, `rejected` or `failed` |

Without `include=timeline`, or with any other `include` value, the body has no `timeline`.
