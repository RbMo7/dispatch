# API

The shipped wire format for `POST /v1/dispatch`, `GET /v1/dispatch/:id`, `GET /v1/dispatches`, `POST /v1/dispatch/:id/cancel` and `GET /v1/senders`, implemented for both `solana` and `base`. Changes to it are deliberate and recorded in an ADR.

## `POST /v1/dispatch`

Headers:
```
Authorization: Bearer <operator-configured token>   (ADR-0022)
Idempotency-Key: <client-supplied string>            (ADR-0021, required)
```

Body:
```json
{
  "chain": "solana",
  "retryPolicy": false,
  "items": [
    { "type": "payment", "recipient": "<address>", "asset": "USDC", "amount": "10" },
    {
      "type": "call",
      "programId": "<program id>",
      "accounts": [{ "pubkey": "<address>", "isSigner": false, "isWritable": true }],
      "data": "<base64>"
    }
  ]
}
```

A `call` item's fields beyond `type` mirror the target chain's `Call` primitive exactly (CONTEXT.md, ADR-0018) — `{ programId, accounts, data }` for a `solana` Dispatch as shown above, `{ to, data, value }` for a `base` one. `items` mixes `payment` (ADR-0018's convenience shape) and `call` (the primitive) freely in one Dispatch. A `call` item gets the chain's cheap shape check at submission, so a malformed one is a `400`, never queued. Resubmitting the same `Idempotency-Key` returns the original Dispatch's current state (202, same body shape as below) rather than creating a second one.

`retryPolicy` (ADR-0003/0004) is optional; omitting it falls back to the operator's configured global default (itself off unless the operator opts in) — a Dispatch never silently costs more than what was explicitly authorized for it. Once resolved (request value or the global default) it's fixed for that Dispatch's whole lifetime.

Response (`202 Accepted` — this is always async, never a synchronous chain result):
```json
{ "dispatchId": "<id>", "status": "queued" }
```

## `GET /v1/dispatch/:id`

```json
{
  "dispatchId": "<id>",
  "mode": "managed",
  "status": "queued | broadcasting | confirmed | failed | partial | cancelled",
  "items": [
    { "status": "confirmed", "transactionHash": "<hash>", "error": null },
    { "status": "failed", "transactionHash": null, "error": { "code": "INSUFFICIENT_FUNDS", "message": "...", "chainDetail": { "asset": "USDC", "short": "40" } } }
  ]
}
```

`error` follows ADR-0010's structured shape exactly — never a bare string. A `failed` item's `transactionHash` is `null` when it failed before anything was signed (as above), and set when the transaction was signed and then refused: every transaction is written down, hash included, before it is sent (ADR-0041).

Per-item `status` is `queued | awaiting_approval | broadcasting | confirmed | failed | abandoned | cancelled` — its own vocabulary, not the top-level one (it adds `abandoned`, ADR-0004's distinct terminal state, and `awaiting_approval` for a Multisig Sender's Call, below; it never itself reports `partial`, which only describes the aggregate across items). `queued` means the Call hasn't reached a Transaction yet (`transactionHash` still `null`), or, for a Multisig Sender, that it is claimed but not yet in a Proposal; the top-level `status` is derived from the aggregate of item statuses — only `queued`/`broadcasting` (ADR-0009's outbox transition) and `cancelled` (below) are ever persisted directly, so `confirmed`/`failed`/`partial` are computed at read time. An `abandoned` item counts as "not confirmed" for that aggregate, the same as `failed`. An `awaiting_approval` item counts as still in progress, so the top-level `status` stays `broadcasting` while Calls await approval: there is no top-level status for it.

On Solana, an item whose transaction expired without landing is resubmitted with a fresh blockhash, up to 3 times, whatever `retryPolicy` says: the expired one was never charged, so this costs nothing extra (ADR-0042). Its `transactionHash` then changes to the resubmission's. After the third it is `failed`, as is an expired Relay Dispatch, which the engine has no key to re-sign.

With `retryPolicy: true`, a stuck EVM item may be fee-bumped: replaced by a new transaction at the same nonce with higher fees (ADR-0037). While that's in progress, `transactionHash` is the latest version and can change between polls. Once one version lands, `transactionHash` is the one that actually landed, which may be the original.

An item stays `broadcasting` while its transaction is unresolved. That includes a send whose outcome is unknown, such as a timeout: the transaction may have reached the chain, so it is checked (and, on Base, rebroadcast) rather than reported `failed`. It becomes `abandoned` only after the chain's timeout (15 minutes on Base) with no answer (ADR-0041, ADR-0004).

Every `GET /v1/dispatch/:id` response, Managed or Relay alike, includes a top-level `mode: "managed" | "relay"` field (ADR-0031) — added here too, not just below, so a caller can tell which shape it's looking at from the body alone without having to remember which mode it submitted.

### `?include=timeline`

`GET /v1/dispatch/:id?include=timeline` adds a `timeline` array to the same body, Managed or Relay: what happened to the Dispatch, oldest first, rebuilt from the timestamps the engine already keeps. Without the flag the body is exactly as above. Any other `include` value is a `400`.

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

Every entry has `at` (ISO 8601) and `kind`. `items` are the positions of the Calls an entry is about, several when one transaction carries a bundle; a Relay Dispatch's one transaction is item `0`. `hash` names the transaction version.

| `kind` | When | Extra fields |
|---|---|---|
| `created` | `POST /v1/dispatch` stored it | |
| `claimed` | The worker last claimed it. A large Dispatch re-stamps this as it sends, so it can come after its first transactions | |
| `cancelled` | It was cancelled (above) | |
| `written` | A transaction version was signed and written down, before it was sent (ADR-0041) | `hash`, `items`, `replaces` (the hash it replaced, or `null`) |
| `sent` | The node accepted it. Only shown while the version has no `attempt`: a resend overwrites this moment | `hash`, `items` |
| `attempt` | The same bytes were sent again; `error` is the node's answer if it refused | `hash`, `items`, `error` |
| `replaced` | A newer version took its place: a fee-bump (ADR-0037). It may still be the one that lands | `hash`, `items`, `by` |
| `dropped` | It can never land: a newer version replaced it after expiry (ADR-0042), or another version settled the Call | `hash`, `items`, `by` (or `null`) |
| `confirmed`, `failed`, `abandoned` | Its outcome. A `failed` entry with `hash: null` failed before anything was signed | `hash`, `items`, and `error` for `failed` and `abandoned` |
| `proposal_created` | A Multisig Sender's Proposal was written down | `proposalId`, `chainRef`, `items` |
| `proposal_approval` | The Approvers' decision, as the engine last read it: `at` is when the engine acted on it (wrote the execute, or the Proposal timed out or was resolved), and `null` while the Proposal is still open. `null` entries come last | `proposalId`, `state`, `approvals`, `threshold` |
| `proposal_timed_out` | Nobody decided by the deadline (ADR-0053) | `proposalId` |
| `proposal_resolved` | The Proposal ended | `proposalId`, `outcome`: `executed`, `rejected` or `failed` |

## `GET /v1/dispatches`

Managed and Relay Dispatches together, newest first. Same `Authorization` header as above.

Query parameters, all optional:

- `limit`: rows per page, 1 to 100, default 25.
- `cursor`: the `nextCursor` of the previous page. Opaque: pass it back as it came.
- `chain`: `base` or `solana`.
- `mode`: `managed` or `relay`.
- `status`: the top-level status as `GET /v1/dispatch/:id` reports it, derived ones included: `queued | broadcasting | confirmed | failed | partial | abandoned | cancelled` (`abandoned` only for a Relay Dispatch).
- `from`, `to`: ISO 8601 timestamps on `createdAt`, `from` inclusive and `to` exclusive.

A value outside these is a `400`; parameters not listed here are ignored.

```json
{
  "dispatches": [
    {
      "dispatchId": "<id>",
      "mode": "managed",
      "chain": "base",
      "status": "partial",
      "createdAt": "2026-10-31T10:00:00.000Z",
      "itemCount": 3,
      "totals": [{ "asset": "USDC", "amount": "25" }]
    },
    {
      "dispatchId": "<id>",
      "mode": "relay",
      "chain": "solana",
      "status": "confirmed",
      "transactionHash": "<hash>",
      "error": null,
      "createdAt": "2026-10-31T09:59:00.000Z",
      "itemCount": 1,
      "totals": []
    }
  ],
  "nextCursor": "<opaque string> | null"
}
```

Each row is the `GET /v1/dispatch/:id` body without `items`, plus `chain`, `createdAt`, `itemCount` and `totals`: the sum per asset of the `payment` items, in the asset's smallest unit (`call` items carry no amount, and a Relay Dispatch has none). Pages are cut on `(createdAt, id)`, so a Dispatch created while you page appears on no later page and none is skipped or repeated. A page is full unless it is the last; `nextCursor` is `null` on the last page.

## `POST /v1/dispatch/:id/cancel`

Withdraws a Managed or Relay Dispatch the engine has not yet claimed (ADR-0056). Same `Authorization` header as above; no body. The cancel and the worker's claim are decided in one atomic write, so exactly one of them wins.

- `200`: the Dispatch, in the same body as `GET /v1/dispatch/:id`, now `cancelled` at the top level and on every item, with no `transactionHash` or `error`. Nothing was or will be signed, proposed or sent. Cancelling an already-cancelled Dispatch also answers `200` with its current state.
- `409`: the worker already claimed it, whatever its items' state since. The body is `{ "error": { "code": "ALREADY_CLAIMED", "message": "..." } }`.
- `404`: no Dispatch has this id.

`cancelled` is terminal and stored, not derived. Resubmitting a cancelled Dispatch's `Idempotency-Key` returns it (`202`, `status: "cancelled"`) and creates nothing new; send a new key to try again. An open Proposal cannot be cancelled here: rejecting it is the Approvers' call, in Squads or Safe.

## `GET /v1/senders`

One entry per enabled chain: who pays, what it holds, and what the Signer says about the engine's key. Same `Authorization` header as above. The engine reads the chain and the Signer itself, so a browser never talks to either, and keeps the answer for 15 seconds: a console polling it costs at most one round of RPC and Signer reads per 15 seconds.

```json
{
  "senders": [
    {
      "chain": "solana",
      "mode": "squads",
      "address": "<vault>",
      "multisig": { "address": "<multisig>", "threshold": 2, "engineKey": "<member key>" },
      "balances": [
        {
          "holder": "vault",
          "address": "<vault>",
          "assets": [
            { "asset": "SOL", "balance": "9000000", "committed": "0" },
            { "asset": "USDC", "balance": { "error": "RPC_UNAVAILABLE" }, "committed": "120" }
          ]
        },
        {
          "holder": "memberKey",
          "address": "<member key>",
          "assets": [{ "asset": "SOL", "balance": "3000000", "committed": "2039280" }]
        }
      ],
      "signerKey": { "address": "<member key>", "curve": "ed25519", "allowedMultisig": "<multisig>" }
    }
  ]
}
```

- `mode` is `single`, `squads` or `safe`. `address` is the Sender: the plain key, the Squads vault, or the Safe. `multisig` is `null` for `single`; otherwise it names the Squads multisig account or the Safe, its approval `threshold` as the chain reports it, and `engineKey`, the engine's own key (the Squads member key or the Safe executor).
- `balances` are the balances the Funding Check looks at (ADR-0043, ADR-0054), with the same names `INSUFFICIENT_FUNDS` reports in `chainDetail.holder`: `sender` for a plain Sender; `vault` and `memberKey` on Squads; `safe` and `executor` on Safe. Each lists the native asset and every known token (the engine's key only its native asset, which pays the network cost), in the smallest unit. `committed` is what open Proposals and Calls waiting to be proposed already hold back from that balance, the amount the Funding Check subtracts; always `"0"` for a plain Sender.
- `signerKey` is what the Signer answers on `GET /keys/{address}/policy` (ADR-0055) for the key the engine signs with (the Sender for `single`, `engineKey` otherwise): `address`, `curve`, and each pin that is set (`chainIds`, `allowedSafe`, `allowedMultisig`).
- A read that fails degrades only its own field to `{ "error": "<reason>" }`; the rest still returns, with `200`. A balance or `threshold` error is the error code (`RPC_UNAVAILABLE`, …); a `signerKey` error says whether the Signer has no key for the address, is too old to report a policy, or could not be reached. The details go to the engine's log, never into the response, and no secret, key reference or token ever does.

## Multisig approval (`awaiting_approval` and the `approval` block)

Only for a Multisig Sender, a Sender whose address is a multisig wallet (ADR-0049). Its Calls are not signed and sent one by one: the engine groups them into a Proposal for the multisig's Approvers to decide on, then executes it once approved. A Proposal holds Calls from exactly one Dispatch (ADR-0054), so a large Dispatch may become several Proposals. A Dispatch that does not use a Multisig Sender never shows any of this.

While the engine has not yet put a Call into a Proposal, the item is `queued`. Once it is in one, the item is `awaiting_approval`, with `transactionHash: null`: nothing has been executed, so there is no hash. When the Proposal is approved and the engine executes it, the item becomes `broadcasting`, and then `confirmed` or `failed` as usual, with `transactionHash` set to the transaction that executed it. If someone else executes the Proposal **before** its deadline, the item becomes `confirmed` with that executor's hash. If someone else executes it **after** the deadline, the engine still sees it for the re-watch window and the item becomes `confirmed` (below). A Safe Sender also leaves a Dispatch's items `queued`, with no `approval` block, while an earlier Proposal for the same Safe is open, because a Safe holds one open Proposal at a time (ADR-0051).

An item whose Call belongs to a Proposal carries an `approval` block. It is present whenever the Call belongs to a Proposal, including after the item is `abandoned`, `confirmed` or `failed`, and absent otherwise:

```json
{
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

- `state` is `awaiting | approved | approved_after_deadline`. `awaiting` means the Proposal has not reached its threshold, and `approved` means it has, whether it is waiting out a time lock or being executed. `approved_after_deadline` is only seen on an `abandoned` item: the Proposal was approved after the deadline and the engine will not execute it. During the re-watch window `state` follows what the engine last read.
- `approvals` and `threshold` are the votes so far and the votes needed.
- `deadline` is when the engine stops waiting (ISO 8601, 72 hours from the Proposal's creation by default; `SOLANA_APPROVAL_DEADLINE_MS` and `BASE_APPROVAL_DEADLINE_MS`). After it the item is `abandoned` with `APPROVAL_TIMEOUT`, and the engine never executes the Proposal, even if it is approved later.
- `chainRef` is the chain's own handle for the Proposal, so an operator can open it in the multisig's app: `{ "kind": "squads", "multisig", "proposal", "transactionIndex" }` or `{ "kind": "safe", "safe", "safeTxHash", "nonce" }`.
- `expected` is what this Proposal should pay out, built from this Dispatch's own items: how many distinct recipients, and the total per asset in the asset's smallest unit. It is a mistake-catcher, not a control: it lets an Approver notice a wrong file, but it is written by the same engine that wrote the Proposal, so it proves nothing about what the Proposal's bytes really do. The independent verifier (#89) is what checks that.

An `abandoned` item with `APPROVAL_TIMEOUT` is not a failure: an Approver may still approve it and someone else execute it. Check before re-sending, or the payment may happen twice. The engine keeps reading such a Proposal for the re-watch window (below), but a late outcome reaches a caller only through `GET` and the logs, and after the window nothing is seen. An `error` for these codes carries `chainDetail`: `{ "deadlineAt": "<ISO 8601>" }` for `APPROVAL_TIMEOUT`, and `{ "status": "rejected | cancelled | stale" }` for `APPROVAL_REJECTED` raised by the watch (a Safe whose nonce was taken by another transaction reports `rejected`).

A Multisig Sender only proposes native transfers and token transfers (Solana: SOL, SPL and Token-2022; Base: ETH and ERC-20 tokens in `BASE_KNOWN_TOKENS`). `POST /v1/dispatch` checks this before storing anything: a `call` item the multisig cannot hold, or a `bulkCall`, is a `400` (`CHAIN_REJECTED`) whose message names the item (`items[1]: …`), and no Dispatch is stored and the `Idempotency-Key` is not consumed. The same check runs again when the engine plans the Proposals, as a safety net.

The engine keeps reading a timed-out Proposal for a re-watch window (30 days after it timed out by default; `SOLANA_APPROVAL_REWATCH_WINDOW_MS` / `BASE_APPROVAL_REWATCH_WINDOW_MS`), and an `abandoned` item can then change once, and only once:

- someone else executed the Proposal: the item becomes `confirmed`, with `hash` set to the transaction that executed it (it was never sent by the engine, so there is no engine-signed transaction behind it);
- the Proposal was rejected or cancelled (Squads), made stale before approval, or lost its Safe nonce to a different transaction: the item becomes `failed` with `APPROVAL_REJECTED`;
- approved but not executed: it stays `abandoned` and `approval.state` reads `approved_after_deadline`. The engine never executes it; an operator executes or rejects it in the multisig's app;
- the window ends with no decision: it stays `abandoned` for good, and a later execution goes unseen.

## Bulk Call (`bulkCall`, Base)

A Managed Dispatch on Base can opt into Bulk Call (ADR-0006, ADR-0038). Its items are then sent as `aggregate3Value` transactions through an aggregator contract **you** name. The engine never deploys or owns one.

```json
{
  "chain": "base",
  "bulkCall": { "aggregator": "0x…", "maxBatchSize": 50, "allowFailure": false },
  "items": [ … ]
}
```

- **`maxBatchSize`** is optional. It defaults to, and can't exceed, the operator's `BASE_BULK_CALL_MAX_BATCH_SIZE`. A request with more items is split into several transactions, never truncated.
- **`allowFailure`** is optional and defaults to `false`:
  - **`false`:** the items in a transaction succeed or fail **together**. If any one would fail, the whole transaction reverts and every item in it is reported `failed`, so resubmit the corrected batch. Nothing is ever silently half-done.
  - **`true`:** each item succeeds or fails **on its own**. One failing item is reported `failed` while its batch-mates confirm. The operator must configure a tracing RPC (`BASE_TRACE_RPC_URL`), because per-item outcomes are only visible in a transaction trace.
  - The response shape is the same either way.
- **ERC-20 items spend the aggregator's own token balance.** Inside `aggregate3Value`, the calls come *from the aggregator*, so fund your aggregator with the tokens. Native ETH items are paid by the Sender, which sends the total along with the call. The Funding Check checks each against its real payer.
- **Returns `400`:**
  - `mode: "relay"`;
  - a chain without Bulk Call;
  - a malformed aggregator, or one with no contract code;
  - an out-of-range `maxBatchSize`;
  - `allowFailure: true` with no tracing RPC configured (`BASE_TRACE_RPC_URL`);
  - **any ERC-20 item with the canonical Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) as aggregator.** It's permissionless, so any balance or approval it holds can be taken by anyone.

## Relay Dispatch (`mode: "relay"`)

`.scratch/relay-dispatch/spec.md` and ADR-0031 record the design; this pins the shipped wire shape.

`POST /v1/dispatch` gains an optional `mode: "managed" | "relay"` field, defaulting to `"managed"` when omitted — every existing Managed Dispatch request keeps working unchanged. A `mode: "relay"` body is `{ chain, signedTransaction }` — never `items`, never `retryPolicy` (there's no key for the engine to fee-bump with); sending either alongside `mode: "relay"` is a `400`, not a silently-ignored field. `signedTransaction` is a base64-encoded, already-signed transaction the caller produced entirely outside the engine — the same headers (`Authorization`, `Idempotency-Key`) apply, and the same create-once idempotency semantics (ADR-0021). On Solana it may be a legacy or a versioned (v0) transaction, and every required signature must verify. On Base it must be an EIP-1559 (type `0x02`) transaction for the configured chain ID, with a low-s (EIP-2) signature; the usual `0x`-hex raw transaction is accepted there too.

Response (`202 Accepted`, same shape as Managed's): `{ "dispatchId": "<id>", "status": "queued" }`.

`GET /v1/dispatch/:id` for a Relay Dispatch:
```json
{
  "dispatchId": "<id>",
  "mode": "relay",
  "status": "queued | broadcasting | confirmed | failed | abandoned | cancelled",
  "transactionHash": "<hash>",
  "error": null
}
```
One transaction, not a batch — this is the same per-item status vocabulary Managed Dispatch's `items[]` entries use, applied directly at the top level rather than to a fake single-item array (ADR-0031).

## Error codes

For a Multisig Sender, the Funding Check looks at two balances (ADR-0043, ADR-0054): the vault or Safe pays the payments, and the engine's own key (the Squads member key, the Safe executor) pays the network cost and any proposal rent. Both are reduced by what open Proposals already hold. An `INSUFFICIENT_FUNDS` for such a Sender names the short balance: `chainDetail` is `{ "asset": "USDC", "short": "40", "holder": "vault", "address": "<address>", "committed": "100" }`, where `holder` is `vault` or `memberKey` on Solana and `safe` or `executor` on Base, `address` is that balance's address, and `committed` is the amount of that `asset` already held back on it, in the smallest unit, by Proposals still in flight or timed out and still watched (ADR-0053), by Calls waiting to be proposed, and (on the key that proposes) by proposal rent that stays locked until the Proposal is closed. `short` is the extra the holder needs, `committed` included. A plain Sender's shortfall stays `{ "asset", "short" }`.

Every `error` is `{ code, message, chainDetail? }` (ADR-0010). `message` is the most specific human-readable reason available (on Base, the node's own words). `chainDetail` carries the raw chain-side detail (JSON-RPC code, HTTP status, revert data, the shortfall) for debugging, and its shape varies by code and chain.

| `code` | Meaning |
|---|---|
| `INSUFFICIENT_FUNDS` | The payer's balance can't cover it: caught up front by the Funding Check (on Solana, including the SOL for fees and new token-account rent, ADR-0043), or refused by the chain |
| `INVALID_RECIPIENT` | A malformed or unusable address (a recipient, a Bulk Call aggregator with no contract code) |
| `UNKNOWN_ASSET` | A `payment`'s `asset` has no configured encoding on this chain (ADR-0029) |
| `CHAIN_REJECTED` | The chain definitely refused or reverted it, or a request was invalid for this chain (wrong chain ID, bad signature, …). For a Multisig Sender also: a Call it cannot put in a Proposal, a Safe Transaction Service refusal (a 401 key or a 422 for an unregistered delegate), or a Safe execute whose simulation fails (`GS013`) |
| `RPC_UNAVAILABLE` | The chain's RPC couldn't be reached or answered (timeout, rate limit, 5xx) |
| `SIGNER_UNREACHABLE` | The Signer couldn't be reached or returned an unusable signature |
| `SIGNER_REFUSED` | The Signer refused to sign it under its policy (ADR-0046). Definite: the Call is `FAILED` and never retried; `message` carries the Signer's reason |
| `CHAIN_NOT_ENABLED` | The request names a chain this deployment hasn't enabled (ADR-0019) |
| `NONCE_ALREADY_USED` | The transaction's nonce was already consumed on-chain (Base) |
| `APPROVAL_REJECTED` | A Multisig Sender's Proposal was rejected or cancelled by its Approvers before its deadline, or went stale (Safe: its nonce was taken by a different transaction). Definite: the item is `failed`, with `transactionHash: null` (ADR-0049, ADR-0054) |
| `APPROVAL_TIMEOUT` | Nobody decided on the Proposal by its `deadline`. The item is `abandoned`, not `failed` (ADR-0053): the Proposal may still be approved and executed by someone else, so a caller must check before re-sending |

One more code exists internally, `ALREADY_KNOWN` (the node already has these exact bytes). It is never reported: it means "sent", so the item stays `broadcasting` until it resolves.

## Not yet specced here

- Webhooks (ADR-0023) — polling above is the required baseline for now.
- Ethereum L1 — a separate, undesigned future chain, not "the rest of evm" (ADR-0035).
