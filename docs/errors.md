# Errors

An error reaches you in one of two places. If the API refuses your request, the HTTP answer carries the error and nothing was stored. If the API accepted the request and an item later fails, the item's `error` field carries it, and you read it from [Get a Dispatch](./openapi.yaml#get-a-dispatch).

## The three shapes of a refusal

**A structured error** has a `code` you can switch on. Items use the same shape.

```json
{
  "code": "UNKNOWN_ASSET",
  "message": "no known token configured for asset \"DAI\"",
  "chainDetail": { "asset": "DAI" }
}
```

`code` is one of the [codes below](#error-codes). `message` is the most specific reason the engine has, for people. On Base it is often the node's own words. `chainDetail` is optional. It carries the raw detail from the chain or the check, such as a shortfall, a JSON-RPC code, an HTTP status or revert data, and its shape depends on the code and the chain.

**A plain error** has only a message. The API answers with it for `401`, `404`, and a `400` that has no code, such as a missing `Idempotency-Key` or a malformed item:

```json
{ "error": "Idempotency-Key header is required" }
```

**A request error** means the HTTP server refused the request before the route read it. `code` starts with `FST_ERR_`:

```json
{
  "statusCode": 400,
  "code": "FST_ERR_VALIDATION",
  "error": "Bad Request",
  "message": "body/chain must be equal to one of the allowed values"
}
```

| `code` | Status | Cause |
| --- | --- | --- |
| `FST_ERR_VALIDATION` | `400` | The body or the query string broke the route's schema, such as an unknown `chain`, an unknown body field, or a `limit` over 100. `message` names the field. |
| `FST_ERR_CTP_INVALID_JSON_BODY` | `400` | The body is not valid JSON. |
| `FST_ERR_CTP_BODY_TOO_LARGE` | `413` | The body is over 1 MiB. Split the run into several Dispatches. |

The engine records every refused request to create a Dispatch, except a `401`, with its body, for the operator to read with [List refused requests](./openapi.yaml#list-refused-requests) or on the console's Rejected page. A refusal still stores no Dispatch and does not use up its key.

Branch on `code` when the body has one of the [error codes](#error-codes) below. Otherwise branch on the HTTP status, and show `error` or `message` to people.

## HTTP status codes

| Status | Means |
| --- | --- |
| `200` | Read, cancelled, released, or a Flag Rule edited or deleted. |
| `201` | A Flag Rule is created. |
| `202` | The Dispatch is stored, or an existing one is returned for its `Idempotency-Key`. |
| `400` | The request is invalid. Nothing was stored, and the `Idempotency-Key` is not used up. |
| `401` | The `Authorization` header is missing, or its token is neither the engine's `AUTH_TOKEN` nor its `OPERATOR_TOKEN`. |
| `403` | The route needs the [operator token](./authentication.md#the-operator-token), and the request sent `AUTH_TOKEN`, or the engine has no `OPERATOR_TOKEN`. |
| `404` | No Dispatch, Flag Rule or Known Asset has this id. An id that is not a UUID gets the same answer. |
| `409` | Too late to cancel: the worker already claimed the Dispatch (`ALREADY_CLAIMED`). Or nothing to release (`NOT_HELD`), or an edit to a deleted Flag Rule (`RULE_DELETED`). For a Known Asset: the address or the symbol is taken (`ASSET_EXISTS`, `SYMBOL_TAKEN`), or the asset comes from the configuration (`CONFIG_ASSET`). |
| `503` | Adding or previewing a Known Asset: the chain could not be read (`RPC_UNAVAILABLE`). |
| `413` | The body is over 1 MiB. |

## Error codes

| `code` | Where you see it | What happened | What to do |
| --- | --- | --- | --- |
| `INSUFFICIENT_FUNDS` | An item, `failed` | The payer cannot cover it. The [Funding Check](./lifecycle.md#the-funding-check) caught it before signing, or the chain refused it. On Solana the check counts the SOL for fees and for new token accounts too. | Top up the payer by at least `chainDetail.short`, then send the failed payments again in a new Dispatch with a new key. |
| `INVALID_RECIPIENT` | `400` | A malformed or unusable address: a recipient, or a Bulk Call aggregator with no contract code. | Fix the address. |
| `UNKNOWN_ASSET` | `400` | A `payment` names an asset that is not an enabled Known Asset on its chain. | Use `ETH`, `SOL`, or a symbol `GET /v1/assets` lists as enabled. The operator can add a token with `POST /v1/assets`. |
| `CHAIN_REJECTED` | `400`, or an item, `failed` | At submission: malformed calldata, relay bytes that are not a valid transaction, a Bulk Call the engine cannot send, or a call a Multisig Sender cannot propose. On an item: the chain definitely refused or reverted it. For a Multisig Sender also a refusal from the Safe Transaction Service (`401` for a bad API key, `422` for an unregistered delegate) or a Safe execute whose simulation fails (`GS013`). | Read `message` and `chainDetail`, fix the cause, and send it in a new Dispatch. Sending the same thing again fails the same way. |
| `RPC_UNAVAILABLE` | An item, `failed` | The chain's RPC could not be reached or did not answer: a timeout, a rate limit or a `5xx`. If the engine cannot read a balance for the Funding Check, it fails the items rather than send them unchecked. | Send them again later with a new key. Operators should use their own RPC provider for real traffic. |
| `SIGNER_UNREACHABLE` | An item, `failed` | The worker could not reach the Signer, or got back an unusable signature. Nothing was sent. | The operator checks the Signer ([troubleshooting](./self-hosting/signer.md#10-troubleshoot-from-the-engines-side)). Then send again with a new key. |
| `SIGNER_REFUSED` | An item, `failed` | The Signer refused the transaction under its policy. `message` is `signer refused: <reason>`. It is definite, and the engine never retries it. | Fix the request, or ask the operator to change the policy. |
| `CHAIN_NOT_ENABLED` | `400` | The `chain` is valid but not in the engine's `ENABLED_CHAINS`. | Use an enabled chain. [List Senders](./openapi.yaml#list-senders) shows them. |
| `UNKNOWN_SENDER` | `400` | The request's `sender`, or a list's `sender` filter, names a Sender the chain does not have. | Use a name [List Senders](./openapi.yaml#list-senders) shows. |
| `SENDER_REQUIRED` | `400` | A Managed Dispatch names no `sender` on a chain whose senders file names no default. | Name the Sender with `sender`. |
| `NONCE_ALREADY_USED` | An item, `failed` | Base only. The transaction's nonce was already used on chain, usually because something else sent from the Sender. | Make sure only the engine sends from the Sender, then send again. |
| `APPROVAL_REJECTED` | An item, `failed` | Multisig only. The Approvers rejected or cancelled the Proposal before its deadline, or it went stale. A Safe whose nonce was taken by a different transaction counts as rejected. It is definite: `transactionHash` is `null` and nothing was paid. | Send it again only if the Approvers want it. |
| `APPROVAL_TIMEOUT` | An item, `abandoned` | Multisig only. Nobody decided on the Proposal by its deadline. The Proposal may still be approved and executed by someone else. | Check the multisig before you send the payment again, or it may happen twice. |
| `ALREADY_CLAIMED` | `409` | You tried to cancel a Dispatch the worker already claimed. | Nothing. The Dispatch is being sent. |
| `NOT_HELD` | `409` | You tried to release a Dispatch that is not `held`: already released, cancelled, never held, or a Relay Dispatch. | Nothing. Read the Dispatch to see where it is. |
| `RULE_DELETED` | `409` | You tried to edit a deleted Flag Rule. | Create a new rule. |
| `NOT_A_TOKEN` | `400` | Adding a Known Asset: the address is not a token. On Base it has no contract, or does not answer `decimals()` and `totalSupply()`. On Solana it is not a mint. | Check the address and the chain. |
| `NOT_PAYABLE` | `400` | Adding a Known Asset: a Solana mint the engine can't pay out correctly, one with a transfer fee, a transfer hook, no transfers, or new accounts frozen. | Pay in another token. |
| `SYMBOL_REQUIRED` | `400` | Adding a Known Asset: the token publishes no usable symbol. | Send `symbol`. |
| `SYMBOL_TAKEN` | `409` | Adding or enabling a Known Asset: another enabled asset on the chain has the symbol, ignoring case. | Send another `symbol`, or disable the other asset first. |
| `ASSET_EXISTS` | `409` | Adding a Known Asset that is already one, enabled or not. | Enable it with `PATCH /v1/assets/{id}`. |
| `CONFIG_ASSET` | `409` | Enabling or disabling an asset that comes from `*_KNOWN_TOKENS` or is a native coin. | Change the variable and restart. |

The engine has one more code, `ALREADY_KNOWN`, which it never reports. It means the node already had the exact bytes, so the item stays `broadcasting` until it resolves.

## What `chainDetail` holds

For `INSUFFICIENT_FUNDS` from a plain Sender, `chainDetail` names the asset and the shortfall in its smallest unit. This item asked for 40 USDC from a Sender with none:

```json
{
  "code": "INSUFFICIENT_FUNDS",
  "message": "insufficient USDC balance",
  "chainDetail": { "asset": "USDC", "short": "40000000" }
}
```

For a Multisig Sender it also names which balance is short, its address, and how much open Proposals already hold back on it:

```json
{ "asset": "USDC", "short": "40", "holder": "vault", "address": "<the vault's address>", "committed": "100" }
```

`holder` is `vault` or `memberKey` on Solana, and `safe` or `executor` on Base. The vault or the Safe pays the payments. The engine's own key, the Squads member key or the Safe executor, pays the network fees and any Proposal rent. `committed` is the amount of that asset already held back on that balance, in the smallest unit, by Proposals in flight or timed out and still watched, by Calls waiting to be proposed, and on the proposing key by Proposal rent that stays locked until the Proposal is closed. `short` is the extra the holder needs, `committed` included.

For `CHAIN_REJECTED` on a Base transaction that reverted, the engine replays it with `eth_call` at its block to read why, and `message` starts with `reverted:`. `chainDetail` has the block, the gas used and the gas limit, plus `reason` and the raw `revertData`. A `require` message is the reason as written, a `Panic` is named by its meaning, and a custom error by its selector. A transaction that used all its gas says it ran out of gas. When the chain cannot be read, the item fails with the plain message and no reason:

```json
{
  "code": "CHAIN_REJECTED",
  "message": "reverted: always reverts",
  "chainDetail": {
    "block": "53146767",
    "reason": "always reverts",
    "gasUsed": "21485",
    "gasLimit": "500000",
    "revertData": "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000e616c776179732072657665727473000000000000000000000000000000000000"
  }
}
```

For `APPROVAL_TIMEOUT`, `chainDetail` is `{ "deadlineAt": "<ISO 8601>" }`. For an `APPROVAL_REJECTED` the engine found while watching a Proposal, it is `{ "status": "rejected" }`, `"cancelled"` or `"stale"`.

## Failed before or after signing

A `failed` item's `transactionHash` is `null` when it failed before anything was signed, as with the Funding Check above. It is set when the transaction was signed and then refused, because the engine writes every transaction down, hash included, before it sends it.

## Retry safely

- **`failed`** means the payment did not happen and will not. Fix the cause and send it again with a new `Idempotency-Key`.
- **`abandoned`** means the engine stopped waiting without a definite answer. The transaction or the Proposal may still land. Check the chain or the multisig before you send it again.
- **`broadcasting`** means the transaction is out. Never send it again while an item is `broadcasting`.

[The Dispatch lifecycle](./lifecycle.md) explains each status.
