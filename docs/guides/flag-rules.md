# Hold payments with Flag Rules

A Flag Rule is a condition you set, such as "any SOL payment over 5 SOL". The engine checks every Managed Dispatch against the enabled rules on its chain when it is submitted. A Dispatch that matches any of them is stored whole as `held`. Nothing is signed, proposed or sent until someone with the operator token releases it, or anyone cancels it. A held Dispatch has no deadline.

Use a hold where a person should look before money moves: a mistyped amount, a wrong payment file, a client stuck in a loop, or a payee you have never paid. A rule catches mistakes. It is not a security control, and [what Flag Rules do not protect against](#what-flag-rules-do-not-protect-against) explains why.

The examples run on Solana devnet, with amounts in SOL. Base works the same way with `"chain": "base"`, ETH and its tokens.

## Before you start: set the operator token

Writing rules and releasing Dispatches take the [operator token](../authentication.md#the-operator-token), `OPERATOR_TOKEN`. Reading rules and cancelling take either token. Until you set it, every operator route answers `403`, so no rule can be written and nothing can be held.

Generate it as you did `AUTH_TOKEN`, set it in the API's environment, and restart the API:

```sh
openssl rand -hex 32
```

Keep the two tokens apart:

- `AUTH_TOKEN` goes to your application's servers, which submit Dispatches.
- `OPERATOR_TOKEN` goes only to the people who review holds and write rules. Store it in a different secret than `AUTH_TOKEN`, and never in your application's configuration.

If your application held the operator token, it could release its own held Dispatches, and a hold would stop nothing. The API refuses to start when `OPERATOR_TOKEN` is set but empty, or equal to `AUTH_TOKEN`. `pnpm dispatch doctor` warns while it is unset and fails while it is shorter than 32 characters. The examples use `$DISPATCH_TOKEN` for the API token and `$OPERATOR_TOKEN` for the operator token.

`AUTH_TOKEN` gets `403` on every operator route:

```json
{ "error": "this route needs OPERATOR_TOKEN, not AUTH_TOKEN" }
```

## 1. Write the rule

A rule is a `name`, a `chain` (`base` or `solana`), a `kind`, and exactly that kind's parameters. Any other field is a `400`. Three fields are optional:

- `enabled`, default `true`. A disabled rule matches nothing but stays on the list.
- `sender`, the name of one configured Sender. The rule then checks only the Dispatches that Sender pays. Without it, the rule checks every Sender on its chain. A name the chain does not have is a `400`. [Send from more than one Sender](./multiple-senders.md) explains named Senders.
- `reason`, kept with the change in the activity record.

| `kind` | Parameters | Matches a Dispatch when |
| --- | --- | --- |
| `item_over` | `asset`, `limit` | one `payment` item of `asset` is over `limit` |
| `dispatch_total_over` | `asset`, `limit` | its `payment` items of `asset` add up to more than `limit` |
| `daily_volume_over` | `asset`, `limit` | the `payment` items of `asset` in Managed Dispatches accepted in the last 24 hours and not cancelled, held ones included, plus this one's, add up to more than `limit` |
| `first_time_recipient` | none | a `payment` item's recipient has never had a confirmed payment from this engine on this chain |
| `recipient_not_allowlisted` | `addresses` | a `payment` item's recipient is not in `addresses` |
| `call_target_not_allowlisted` | `addresses` | a `call` item's `to` (Base) or `programId` (Solana) is not in `addresses` |

`limit` is a decimal string in whole units of the asset, such as `"5"` or `"0.5"`. That is unlike a payment item's `amount`, which is in the smallest unit. It must be more than zero and have no more decimal places than the asset. `asset` must be one the engine knows on that chain. Each of `addresses` must be valid on that chain. Base addresses are stored checksummed and compared without regard to case.

The check reads only the engine's own database, never a chain. Amounts are compared as integers in the asset's smallest unit. [The six rule kinds](#the-six-rule-kinds) has a worked example of each.

To hold only the hot Sender's large payments, scope the rule to it:

```json
{ "name": "Large payout", "chain": "solana", "sender": "payouts", "kind": "item_over", "asset": "USDC", "limit": "5000" }
```

## 2. Preview it

Before you switch a rule on, ask how many of the last 30 days' Managed Dispatches on its chain it would have held. Nothing is saved. This preview tries a limit of 1 SOL:

```sh
curl -s -X POST "$DISPATCH_URL/v1/flag-rules/preview" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chain":"solana","kind":"item_over","asset":"SOL","limit":"1"}'
```

```json
{
  "from": "2026-10-02T12:53:35.763Z",
  "to": "2026-11-01T12:53:35.763Z",
  "scanned": 9,
  "capped": false,
  "wouldHold": 2,
  "examples": [
    { "dispatchId": "eba76155-895e-4ce1-8c1c-3d4fa93be40b", "createdAt": "2026-11-01T12:52:39.636Z", "items": [0, 1, 2] },
    { "dispatchId": "03c89671-2005-4f7d-baaf-936ce4d4dae1", "createdAt": "2026-11-01T12:52:25.266Z", "items": [1] }
  ]
}
```

`scanned` is how many Dispatches in the window were checked, cancelled ones included, and `wouldHold` how many the rule matches. `examples` lists up to 10 of them, newest first, with the positions of the items it matched. Each Dispatch is checked with the facts as they were when it was submitted. One preview reads at most 2,000 Dispatches. When there were more, `capped` is `true` and `wouldHold` is a lower bound.

## 3. Create it

A limit of 5 SOL suits this engine better:

```sh
curl -s -X POST "$DISPATCH_URL/v1/flag-rules" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Large SOL payment","chain":"solana","kind":"item_over","asset":"SOL","limit":"5","reason":"finance reviews any single payment over 5 SOL"}'
```

```json
{
  "ruleId": "43735ae0-8228-45b3-aa9d-23622d4a985d",
  "version": 1,
  "name": "Large SOL payment",
  "chain": "solana",
  "enabled": true,
  "kind": "item_over",
  "asset": "SOL",
  "limit": "5",
  "createdAt": "2026-11-01T12:52:25.239Z",
  "updatedAt": "2026-11-01T12:52:25.239Z",
  "deletedAt": null,
  "versions": [
    {
      "version": 1,
      "name": "Large SOL payment",
      "chain": "solana",
      "enabled": true,
      "kind": "item_over",
      "asset": "SOL",
      "limit": "5",
      "createdAt": "2026-11-01T12:52:25.239Z"
    }
  ]
}
```

`201` returns the rule in version 1, with its `ruleId`. It applies to the next Dispatch submitted, with no restart. A `400` names the field at fault:

```json
{ "error": "limit: SOL has 9 decimal places, so \"5.0000000001\" is too precise" }
```

## 4. Watch for held Dispatches

This Dispatch pays 0.0025 SOL and 7.5 SOL. The second item is over the limit:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: payouts-2026-11-01-0050" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "solana",
    "items": [
      { "type": "payment", "recipient": "7wtP4Zab5pdUBgs6G4p37YQz6v8gaWWR684nqbtVjnJr", "asset": "SOL", "amount": "2500000" },
      { "type": "payment", "recipient": "4sjqyqVfAFBFRUk3AVDD9AiBbjakAjQ6rixqmwhKo3Wi", "asset": "SOL", "amount": "7500000000" }
    ]
  }'
```

```json
{ "dispatchId": "03c89671-2005-4f7d-baaf-936ce4d4dae1", "status": "held" }
```

The whole Dispatch waits, including the item under the limit. List the ones still waiting:

```sh
curl -s "$DISPATCH_URL/v1/dispatches?status=held" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatches": [
    {
      "dispatchId": "03c89671-2005-4f7d-baaf-936ce4d4dae1",
      "mode": "managed",
      "chain": "solana",
      "sender": { "name": "payouts", "address": "33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf" },
      "status": "held",
      "createdAt": "2026-11-01T12:52:25.266Z",
      "itemCount": 2,
      "totals": [{ "asset": "SOL", "amount": "7502500000", "decimals": 9 }]
    }
  ],
  "nextCursor": null
}
```

[Get a Dispatch](../openapi.yaml#get-a-dispatch) shows every item as `held`, and a `hold` block with every rule that matched, the items each one matched, and the rule as that version said when it matched:

```json
"hold": {
  "matched": [
    {
      "rule": { "name": "Large SOL payment", "kind": "item_over", "asset": "SOL", "limit": "5" },
      "ruleId": "43735ae0-8228-45b3-aa9d-23622d4a985d",
      "ruleVersion": 1,
      "items": [1]
    }
  ],
  "heldAt": "2026-11-01T12:52:25.266Z"
}
```

A Dispatch keeps its `hold` block after it is released or cancelled.

## 5. Release or cancel it

Here the 7.5 SOL was a typo for 0.75, so cancel the Dispatch. Either token can cancel, and the `reason` is optional:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch/03c89671-2005-4f7d-baaf-936ce4d4dae1/cancel" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"7.5 SOL was a typo for 0.75"}'
```

The Dispatch and every item read `cancelled`, and nothing was signed. Send the corrected payments in a new Dispatch with a new Idempotency-Key. [Cancel a Dispatch](./cancel.md) has the rules.

When the held Dispatch is right, release it. Release takes the operator token and a `reason`. This one was held by a [first-time recipient rule](#first_time_recipient):

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch/fbd73f42-3dcb-4317-8628-3c4f7a16addb/release" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"new contractor, checked their invoice"}'
```

```json
{
  "dispatchId": "fbd73f42-3dcb-4317-8628-3c4f7a16addb",
  "mode": "managed",
  "chain": "solana",
  "sender": { "name": "payouts", "address": "33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf" },
  "createdAt": "2026-11-01T12:53:11.676Z",
  "status": "queued",
  "items": [
    {
      "type": "payment",
      "recipient": "7pjWZLwxmGazbTZ54yzxH96kYmBWbBzSh2ime2M5h9vS",
      "asset": "SOL",
      "decimals": 9,
      "amount": "4000000",
      "status": "queued",
      "transactionHash": null,
      "error": null
    }
  ],
  "hold": {
    "matched": [
      {
        "rule": { "name": "First payment to a recipient", "kind": "first_time_recipient" },
        "ruleId": "a4c1170b-3a81-4b2f-b1ba-6b137e47338e",
        "ruleVersion": 1,
        "items": [0]
      }
    ],
    "heldAt": "2026-11-01T12:53:11.676Z",
    "releasedAt": "2026-11-01T12:53:25.979Z",
    "reason": "new contractor, checked their invoice"
  }
}
```

`200` returns the Dispatch, now `queued`. It runs from there as if it had never been held, and its `hold` block gains `releasedAt` and `reason`. A Dispatch that is not `held` answers `409`:

```json
{ "code": "NOT_HELD", "message": "this Dispatch is not held, so there is nothing to release" }
```

A release and a cancel of the same Dispatch are each one write conditional on its status. Exactly one of them takes it out of `held`, and a release never revives a cancelled Dispatch. Of two releases, one answers `200` and the other `409`.

## 6. Edit or delete a rule

`PUT /v1/flag-rules/{id}` takes the rule's whole new content and writes the next version. This edit adds a third payee to an allowlist:

```sh
curl -s -X PUT "$DISPATCH_URL/v1/flag-rules/86ffa26f-8420-4df6-bf17-8ae9cd101766" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Known payees only","chain":"solana","kind":"recipient_not_allowlisted","addresses":["7wtP4Zab5pdUBgs6G4p37YQz6v8gaWWR684nqbtVjnJr","4sjqyqVfAFBFRUk3AVDD9AiBbjakAjQ6rixqmwhKo3Wi","7pjWZLwxmGazbTZ54yzxH96kYmBWbBzSh2ime2M5h9vS"],"reason":"new contractor onboarded"}'
```

The answer is the rule at `"version": 2`, with both versions in `versions`. Rules are forward-only. An edit never changes an earlier version, so a held Dispatch always names the version it matched.

`DELETE /v1/flag-rules/{id}` stops the rule matching and takes it off the list, but keeps its id and history. The body and its `reason` are optional:

```sh
curl -s -X DELETE "$DISPATCH_URL/v1/flag-rules/0233129f-1731-4630-b758-def5a30a62c4" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"replaced by the Signer policy allowlist"}'
```

The answer is the rule with `deletedAt` set. Editing a deleted rule answers `409`:

```json
{ "code": "RULE_DELETED", "message": "this Flag Rule is deleted; create a new one" }
```

Editing or deleting a rule never re-checks or releases a Dispatch already held.

## The six rule kinds

Each example shows the rule, the Dispatch it held, and the `hold.matched` entry. All six ran on one engine in this order, and each held Dispatch was cancelled or released before the next rule, so each Dispatch matched only its own rule.

### `item_over`

Holds a Dispatch when any single `payment` item of the asset is over the limit. Use it for a mistyped amount.

```json
{ "name": "Large SOL payment", "chain": "solana", "kind": "item_over", "asset": "SOL", "limit": "5" }
```

A Dispatch paying 0.0025 SOL and 7.5 SOL is held for the second item:

```json
{ "rule": { "name": "Large SOL payment", "kind": "item_over", "asset": "SOL", "limit": "5" }, "ruleId": "43735ae0-8228-45b3-aa9d-23622d4a985d", "ruleVersion": 1, "items": [1] }
```

### `dispatch_total_over`

Holds a Dispatch when its `payment` items of the asset add up to more than the limit, even when each item is under it. Use it for a payment file that is larger than usual.

```json
{ "name": "Large SOL batch", "chain": "solana", "kind": "dispatch_total_over", "asset": "SOL", "limit": "4" }
```

A Dispatch of three 1.5 SOL payments totals 4.5 SOL. No item is over 5 SOL, so `item_over` lets it through, but this rule matches every SOL item:

```json
{ "rule": { "name": "Large SOL batch", "kind": "dispatch_total_over", "asset": "SOL", "limit": "4" }, "ruleId": "53f22842-18bc-49cb-81cc-67aa8ee34775", "ruleVersion": 1, "items": [0, 1, 2] }
```

### `daily_volume_over`

Holds a Dispatch when the asset's payments in the last 24 hours, plus this Dispatch's, add up to more than the limit. Held Dispatches count, and cancelled ones do not. Use it for a client that submits the same payment again and again.

```json
{ "name": "SOL daily volume", "chain": "solana", "kind": "daily_volume_over", "asset": "SOL", "limit": "12" }
```

The two Dispatches above were still held, at 7.5 SOL and 4.5 SOL, and 0.0725 SOL had already been paid that day. A new 1 SOL payment brought the total over 12 SOL:

```json
{ "rule": { "name": "SOL daily volume", "kind": "daily_volume_over", "asset": "SOL", "limit": "12" }, "ruleId": "097ef032-baa0-44e8-9455-2b964733520e", "ruleVersion": 1, "items": [0] }
```

### `recipient_not_allowlisted`

Holds a Dispatch that pays any address not on the list. Use it when you pay a fixed set of payees.

```json
{ "name": "Known payees only", "chain": "solana", "kind": "recipient_not_allowlisted", "addresses": ["7wtP4Zab5pdUBgs6G4p37YQz6v8gaWWR684nqbtVjnJr", "4sjqyqVfAFBFRUk3AVDD9AiBbjakAjQ6rixqmwhKo3Wi"] }
```

A Dispatch paying a listed payee and `DWkeF1jW4nNwXdESiV3MjRQAb4Pt84gYWTM64e69uehM` is held for the second item:

```json
{ "rule": { "name": "Known payees only", "kind": "recipient_not_allowlisted", "addresses": ["7wtP4Zab5pdUBgs6G4p37YQz6v8gaWWR684nqbtVjnJr", "4sjqyqVfAFBFRUk3AVDD9AiBbjakAjQ6rixqmwhKo3Wi"] }, "ruleId": "86ffa26f-8420-4df6-bf17-8ae9cd101766", "ruleVersion": 1, "items": [1] }
```

### `call_target_not_allowlisted`

Holds a Dispatch with a `call` item whose program (Solana) or contract (Base) is not on the list. Payments are not checked. Use it when your application calls only a few programs.

```json
{ "name": "Memo program only", "chain": "solana", "kind": "call_target_not_allowlisted", "addresses": ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"] }
```

A Dispatch that calls the older Memo program, `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`, and pays a listed payee is held for the call:

```json
{ "rule": { "name": "Memo program only", "kind": "call_target_not_allowlisted", "addresses": ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"] }, "ruleId": "0233129f-1731-4630-b758-def5a30a62c4", "ruleVersion": 1, "items": [0] }
```

### `first_time_recipient`

Holds a Dispatch that pays an address this engine has never paid on this chain. A payment counts only once it is confirmed. Use it so that a person checks every new payee once.

```json
{ "name": "First payment to a recipient", "chain": "solana", "kind": "first_time_recipient" }
```

A 0.004 SOL payment to `7pjWZLwxmGazbTZ54yzxH96kYmBWbBzSh2ime2M5h9vS`, never paid before, is held. This is the Dispatch released in step 5. Once that payment confirmed, the next payment to the same address goes straight through.

```json
{ "rule": { "name": "First payment to a recipient", "kind": "first_time_recipient" }, "ruleId": "a4c1170b-3a81-4b2f-b1ba-6b137e47338e", "ruleVersion": 1, "items": [0] }
```

## What a rule never checks

- **A Relay Dispatch.** Its transaction is already signed by someone else.
- **A repeated `Idempotency-Key`.** It answers with the stored Dispatch, held or not, whatever the rules say now.
- **What a `call` item does.** Amount rules count only `payment` items. A token transfer you encode yourself as a `call` is not counted by `item_over`, `dispatch_total_over` or `daily_volume_over`.

## What Flag Rules do not protect against

Flag Rules run inside the engine, and the engine's own database and API decide them. Anything that controls the engine controls the rules. They do not protect against:

- **A leaked operator token.** Whoever holds it can release any held Dispatch, and switch off or delete any rule.
- **Someone who can write the engine's database or run code on its host.** The rules, the holds and the activity record are rows in that database.
- **A compromised engine.** The API checks the rules when it accepts a Dispatch, and the worker signs whatever it claims. Changed code on either one can skip the check.
- **Payments sent around the engine.** A Relay Dispatch is never checked, and anyone else who holds a Sender's key can send without the engine.

Put the limits that must never be crossed in the Signer's policy instead. The Signer is a separate process, with its own token, that only the worker can reach. It reads every transaction's bytes before it signs and refuses anything outside its policy: a chain, a destination, or an amount per transaction. Nothing the engine or its API does can change that policy, and a refusal is final, where a hold waits for a person. [Write a policy for every address](../self-hosting/signer.md#4-write-a-policy-for-every-address) shows how.

Use both. The Signer's policy is the hard limit that nothing may exceed. Flag Rules hold, below that limit, what a person should look at first.

## The activity record

Every cancel that lands, every release, and every rule create, edit and delete is written to the activity record, with the token kind and the `reason`. Read it with [List operator actions](../openapi.yaml#list-operator-actions):

```sh
curl -s "$DISPATCH_URL/v1/activity?limit=3" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

```json
{
  "actions": [
    {
      "id": "70bddef7-bc4e-4c8b-8540-5ce724928615",
      "at": "2026-11-01T12:53:26.013Z",
      "action": "flag_rule_delete",
      "targetId": "0233129f-1731-4630-b758-def5a30a62c4",
      "tokenKind": "operator",
      "reason": "replaced by the Signer policy allowlist"
    },
    {
      "id": "832d962d-1482-475e-b804-80d41b0955eb",
      "at": "2026-11-01T12:53:25.977Z",
      "action": "release",
      "targetId": "fbd73f42-3dcb-4317-8628-3c4f7a16addb",
      "tokenKind": "operator",
      "reason": "new contractor, checked their invoice"
    },
    {
      "id": "90054d08-66fe-4825-b244-2f0e65b3e82e",
      "at": "2026-11-01T12:53:11.663Z",
      "action": "flag_rule_create",
      "targetId": "a4c1170b-3a81-4b2f-b1ba-6b137e47338e",
      "tokenKind": "operator",
      "reason": null
    }
  ],
  "nextCursor": "WyIyMDI2LTExLTAxVDEyOjUzOjExLjY2MzI3NVoiLCI5MDA1NGQwOC02NmZlLTQ4MjUtYjI0NC0yZjBlNjViM2U4MmUiXQ"
}
```

Each action is also written to the engine's log as an `operator action` line. The activity record says which token acted, never which person, because both tokens are shared secrets.
