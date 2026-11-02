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
{ "dispatchId": "e93df02f-e533-4218-9cda-f4f1b41f24c9", "status": "queued" }
```

## 2. Poll it with its timeline

Ask for the Dispatch with `include=timeline`:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID?include=timeline" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

Before the worker claims it, every item is `queued` and the timeline has one entry. This answer came back right after the submit:

```json
{
  "dispatchId": "e93df02f-e533-4218-9cda-f4f1b41f24c9",
  "mode": "managed",
  "chain": "solana",
  "sender": { "name": "payouts", "address": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
  "createdAt": "2026-11-01T17:40:27.585Z",
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
  "timeline": [{ "kind": "created", "at": "2026-11-01T17:40:27.585Z" }]
}
```

Poll every few seconds. [Polling for results](../polling.md) has a loop that stops when the Dispatch is final.

## 3. Read the timeline

Once the worker ran, the same request returns both items `confirmed`, and a timeline of five entries:

```json
"timeline": [
  { "kind": "created", "at": "2026-11-01T17:40:27.585Z" },
  { "kind": "claimed", "at": "2026-11-01T17:40:29.058Z" },
  { "kind": "written", "at": "2026-11-01T17:40:31.289Z", "hash": "2jAz4GkWuUUwMzWFM3f4Rk4uNp1xCSGEAAV6isr9g3D8HTX8y23nmo5NnVV24esiChjNeFrYBjvivoaUqzQv9PD6", "items": [0, 1], "replaces": null },
  { "kind": "sent", "at": "2026-11-01T17:40:31.804Z", "hash": "2jAz4GkWuUUwMzWFM3f4Rk4uNp1xCSGEAAV6isr9g3D8HTX8y23nmo5NnVV24esiChjNeFrYBjvivoaUqzQv9PD6", "items": [0, 1] },
  { "kind": "confirmed", "at": "2026-11-01T17:40:33.386Z", "hash": "2jAz4GkWuUUwMzWFM3f4Rk4uNp1xCSGEAAV6isr9g3D8HTX8y23nmo5NnVV24esiChjNeFrYBjvivoaUqzQv9PD6", "items": [0, 1] }
]
```

Read it top to bottom:

1. `created`: the API stored the Dispatch.
2. `claimed`: the worker claimed it 1.5 seconds later.
3. `written`: 2.2 seconds after that, one signed transaction carrying items 0 and 1 was written down, before it was sent. On Solana the engine packs several payments into one transaction.
4. `sent`: the node accepted it 0.5 seconds later.
5. `confirmed`: the chain confirmed it 1.6 seconds after that.

Both items carry the same `transactionHash`. Open it in an explorer: `https://explorer.solana.com/tx/<transactionHash>?cluster=devnet`, or on Base Sepolia `https://sepolia.basescan.org/tx/<transactionHash>`.

## When an item fails before signing

This Dispatch paid ETH and a test token, `FLOW`, of which the Sender held too little. Its timeline shows a `failed` entry with `hash: null`: the Funding Check failed the `FLOW` item right after the claim, before anything was signed.

```json
"timeline": [
  { "kind": "created", "at": "2026-11-01T16:44:48.033Z" },
  { "kind": "claimed", "at": "2026-11-01T16:44:48.290Z" },
  {
    "kind": "failed",
    "at": "2026-11-01T16:44:48.786Z",
    "hash": null,
    "items": [1],
    "error": { "code": "INSUFFICIENT_FUNDS", "message": "insufficient FLOW balance", "chainDetail": { "asset": "FLOW", "short": "1001001500000" } }
  },
  { "kind": "written", "at": "2026-11-01T16:44:49.275Z", "hash": "0xae879f57fb8426063d97a216c29bac8727d13d99846fb7ad2b3df739af7897f9", "items": [0], "replaces": null },
  { "kind": "sent", "at": "2026-11-01T16:44:49.558Z", "hash": "0xae879f57fb8426063d97a216c29bac8727d13d99846fb7ad2b3df739af7897f9", "items": [0] },
  { "kind": "confirmed", "at": "2026-11-01T16:44:51.329Z", "hash": "0xae879f57fb8426063d97a216c29bac8727d13d99846fb7ad2b3df739af7897f9", "items": [0] }
]
```

## When a transaction is replaced

A fee bump on Base, or a resubmission after a Solana blockhash expired, makes a new transaction with a new hash. The timeline shows every version.

This Base payment had [Retry Policy](../lifecycle.md#retry-policy-and-stuck-transactions) on, and its first version was priced under the network's base fee, so it stayed pending. 30 seconds later the engine signed a replacement at the same nonce with higher fees, and the replacement confirmed:

```json
"timeline": [
  { "kind": "created", "at": "2026-11-01T17:28:39.802Z" },
  { "kind": "claimed", "at": "2026-11-01T17:28:40.136Z" },
  { "kind": "written", "at": "2026-11-01T17:28:41.050Z", "hash": "0x555bcfa75a49d9de6df8941105d398d948c5ef0a98b946873b49c1720bd47bde", "items": [0], "replaces": null },
  { "kind": "sent", "at": "2026-11-01T17:28:41.345Z", "hash": "0x555bcfa75a49d9de6df8941105d398d948c5ef0a98b946873b49c1720bd47bde", "items": [0] },
  { "kind": "written", "at": "2026-11-01T17:29:12.323Z", "hash": "0x3a3f77cb5290998eceb477dc512c33458ea60ec444bb14d3fea23adff1be933c", "items": [0], "replaces": "0x555bcfa75a49d9de6df8941105d398d948c5ef0a98b946873b49c1720bd47bde" },
  { "kind": "dropped", "at": "2026-11-01T17:29:12.323Z", "hash": "0x555bcfa75a49d9de6df8941105d398d948c5ef0a98b946873b49c1720bd47bde", "items": [0], "by": "0x3a3f77cb5290998eceb477dc512c33458ea60ec444bb14d3fea23adff1be933c" },
  { "kind": "sent", "at": "2026-11-01T17:29:12.618Z", "hash": "0x3a3f77cb5290998eceb477dc512c33458ea60ec444bb14d3fea23adff1be933c", "items": [0] },
  { "kind": "confirmed", "at": "2026-11-01T17:29:14.876Z", "hash": "0x3a3f77cb5290998eceb477dc512c33458ea60ec444bb14d3fea23adff1be933c", "items": [0] }
]
```

The second `written` entry names the version it `replaces`. While both versions were pending, the first one read `replaced`, because either could still land. Once the replacement confirmed, the first one can never land, so it reads `dropped`, at the time it was replaced. While this happens, the item's `transactionHash` is the latest version, and it can change between polls. Once a version lands, `transactionHash` is the one that landed, which may be the original.

A Solana transaction that expires looks the same, with `dropped` straight away, because an expired blockhash can never land. This payment was signed over a blockhash that had already expired, so the engine resubmitted it with a fresh one:

```json
"timeline": [
  { "kind": "created", "at": "2026-11-01T17:29:56.328Z" },
  { "kind": "claimed", "at": "2026-11-01T17:29:57.590Z" },
  { "kind": "written", "at": "2026-11-01T17:29:58.264Z", "hash": "54AfcqJiA5SyvxdfXsdYh7fxdu3UoqrhyiWPFjQQLNxSTiL4V3tCNayQLiZUN6F3ABDA4CjFUiKkqFQVBPfkoHjV", "items": [0], "replaces": null },
  { "kind": "sent", "at": "2026-11-01T17:29:58.271Z", "hash": "54AfcqJiA5SyvxdfXsdYh7fxdu3UoqrhyiWPFjQQLNxSTiL4V3tCNayQLiZUN6F3ABDA4CjFUiKkqFQVBPfkoHjV", "items": [0] },
  { "kind": "written", "at": "2026-11-01T17:30:00.818Z", "hash": "QgwBSWJPLngXgdUXkkicXnC2qh4JA5ypd4P9Ybmfn5w1a9GwkBzqDJ3yGeWxH9uecQji1D3YbrVmx3guMzdMWTE", "items": [0], "replaces": "54AfcqJiA5SyvxdfXsdYh7fxdu3UoqrhyiWPFjQQLNxSTiL4V3tCNayQLiZUN6F3ABDA4CjFUiKkqFQVBPfkoHjV" },
  { "kind": "dropped", "at": "2026-11-01T17:30:00.818Z", "hash": "54AfcqJiA5SyvxdfXsdYh7fxdu3UoqrhyiWPFjQQLNxSTiL4V3tCNayQLiZUN6F3ABDA4CjFUiKkqFQVBPfkoHjV", "items": [0], "by": "QgwBSWJPLngXgdUXkkicXnC2qh4JA5ypd4P9Ybmfn5w1a9GwkBzqDJ3yGeWxH9uecQji1D3YbrVmx3guMzdMWTE" },
  { "kind": "sent", "at": "2026-11-01T17:30:01.145Z", "hash": "QgwBSWJPLngXgdUXkkicXnC2qh4JA5ypd4P9Ybmfn5w1a9GwkBzqDJ3yGeWxH9uecQji1D3YbrVmx3guMzdMWTE", "items": [0] },
  { "kind": "confirmed", "at": "2026-11-01T17:30:05.451Z", "hash": "QgwBSWJPLngXgdUXkkicXnC2qh4JA5ypd4P9Ybmfn5w1a9GwkBzqDJ3yGeWxH9uecQji1D3YbrVmx3guMzdMWTE", "items": [0] }
]
```

When the engine sends the same bytes again, because a send got no answer or a Base transaction is stuck with Retry Policy off, the timeline adds an `attempt` entry for the same `hash` instead of a new `written` one.

## What a call did

A `call` item also carries `call`, what the call does, and once it is confirmed, `effects`, what its transaction changed on chain. [Call a contract or program](./call-a-contract.md#3-read-back-what-the-calls-did) reads both back on each chain.

## Every kind of entry

Every entry has `at`, an ISO 8601 time, and `kind`. `items` are the positions of the items an entry is about, several when one transaction carries a bundle. A Relay Dispatch's one transaction is item `0`. `hash` names one version of a transaction. The timeline is rebuilt from times the engine stores as each step happens, oldest first. Entries with the same time follow the order the steps happen in: `created`, `claimed`, `cancelled`, `proposal_created`, `proposal_approval`, `written`, `sent`, `attempt`, the outcome, `replaced` or `dropped`, then `proposal_timed_out` and `proposal_resolved`. So a `written` entry comes before the `dropped` entry of the version it replaced.

| `kind` | When | Extra fields |
| --- | --- | --- |
| `created` | `POST /v1/dispatch` stored it. | |
| `claimed` | The worker first claimed it. | |
| `cancelled` | It was [cancelled](./cancel.md). | |
| `written` | A transaction version was signed and written down, before it was sent. | `hash`, `items`, `replaces`: the hash it replaced, or `null` |
| `sent` | The node first accepted it. Later resends are `attempt` entries. | `hash`, `items` |
| `attempt` | The same bytes were sent again. `error` is the node's answer if it refused. | `hash`, `items`, `error` |
| `replaced` | A newer version took its place: a fee bump. It may still be the one that lands. Once the item settles on another version, this entry reads `dropped`. | `hash`, `items`, `by` |
| `dropped` | It can never land: a newer version replaced it after expiry, or another version settled the item. | `hash`, `items`, `by` or `null` |
| `confirmed`, `failed`, `abandoned` | Its outcome. A `failed` entry with `hash: null` failed before anything was signed. | `hash`, `items`, and `error` for `failed` and `abandoned` |
| `proposal_created` | A Multisig Sender's Proposal was written down. | `proposalId`, `chainRef`, `items` |
| `proposal_approval` | The Approvers' decision, as the engine last read it. `at` is when the engine acted on it: it wrote the execute, or the Proposal timed out or was resolved. It is `null` while the Proposal is still open, and `null` entries come last. | `proposalId`, `state`, `approvals`, `threshold` |
| `proposal_timed_out` | Nobody decided by the deadline. | `proposalId` |
| `proposal_resolved` | The Proposal ended. A Proposal cancelled in Squads reads `rejected`, because the engine records it as `APPROVAL_REJECTED`. | `proposalId`, `outcome`: `executed`, `rejected` or `failed` |

Without `include=timeline`, or with any other `include` value, the body has no `timeline`.
