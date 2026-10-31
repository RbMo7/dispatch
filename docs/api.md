# HTTP API

The engine's API is JSON over HTTP, served by the API process on port 8420 (`PORT`). These pages pin the wire format of every route, for both `solana` and `base`. Changes to it are deliberate and recorded in an ADR.

| Route | Does |
| --- | --- |
| [`POST /v1/dispatch`](./api/create-dispatch.md) | Create a Managed or Relay Dispatch |
| [`GET /v1/dispatch/:id`](./api/get-dispatch.md) | Read one Dispatch, optionally with its timeline |
| [`GET /v1/dispatches`](./api/list-dispatches.md) | List Dispatches, newest first, with filters |
| [`POST /v1/dispatch/:id/cancel`](./api/cancel-dispatch.md) | Withdraw a Dispatch the engine has not claimed yet |
| [`GET /v1/senders`](./api/senders.md) | Each enabled chain's Sender, its balances and its Signer key |
| `GET /health` | `{ "status": "ok" }` when the API process is up. No token needed. |

Every example in these pages was run against a local engine on Base Sepolia and Solana devnet. They use two shell variables:

```sh
export DISPATCH_URL=http://localhost:8420
export DISPATCH_TOKEN=<your AUTH_TOKEN>
```

## Authentication

Every `/v1` route needs the operator's API token, the engine's `AUTH_TOKEN`, as a bearer token ([ADR-0022](./adr/0022-single-api-key-auth.md)):

```http
Authorization: Bearer <AUTH_TOKEN>
```

There is one token per engine, with no users or scopes. A missing or wrong token is `401`:

```sh
curl -s "$DISPATCH_URL/v1/dispatches"
```

```json
{ "error": "unauthorized" }
```

`AUTH_TOKEN` defaults to `dev-secret`. Set your own in every deployment.

## Idempotency

`POST /v1/dispatch` requires an `Idempotency-Key` header ([ADR-0021](./adr/0021-idempotency-key-required.md)). Creating a Dispatch is create-once: sending the same key again returns the Dispatch the key already created, in its current state, with `202`, and creates nothing. The key is a string you choose, unique across the whole engine. Use something from your own records, such as an invoice or payroll run id.

A request refused with `400` does not use up its key. Fix the request and send it with the same key.

## Asynchronous by design

`POST /v1/dispatch` answers `202 Accepted` as soon as the Dispatch is stored, never with a chain result. Poll [`GET /v1/dispatch/:id`](./api/get-dispatch.md) for the outcome ([ADR-0023](./adr/0023-polling-required-webhooks-later.md)). There are no webhooks yet.

## Errors

A refusal comes in one of three shapes.

**A structured error**, when the refusal has an error code. Every item `error` in a Dispatch has this shape too ([ADR-0010](./adr/0010-structured-errors-not-swallowed.md)):

```json
{
  "code": "UNKNOWN_ASSET",
  "message": "no known token configured for asset \"DAI\"",
  "chainDetail": { "asset": "DAI" }
}
```

`code` is from the table below. `message` is the most specific human-readable reason available, on Base the node's own words. `chainDetail` is optional. It carries the raw chain-side detail, such as a JSON-RPC code, an HTTP status, revert data or a shortfall, for debugging, and its shape varies by code and chain.

**A plain error**, when the refusal has no code, such as a `401`, a `404`, or a request the API cannot read:

```json
{ "error": "Idempotency-Key header is required" }
```

**A schema error**, when the body or query string breaks the route's schema, such as an unknown `chain` or a `limit` over 100:

```json
{
  "statusCode": 400,
  "code": "FST_ERR_VALIDATION",
  "error": "Bad Request",
  "message": "body/chain must be equal to one of the allowed values"
}
```

### HTTP status codes

| Status | Means |
| --- | --- |
| `200` | Read, or cancelled |
| `202` | Dispatch stored, or an existing one returned for its `Idempotency-Key` |
| `400` | The request is invalid. Nothing was stored. |
| `401` | Missing or wrong `AUTH_TOKEN` |
| `404` | No Dispatch has this id |
| `409` | Too late to cancel: the engine already claimed the Dispatch (`ALREADY_CLAIMED`) |

## Error codes

These codes appear in a `400` response and in an item's `error`.

| `code` | Means |
| --- | --- |
| `INSUFFICIENT_FUNDS` | The payer's balance can't cover it: caught up front by the [Funding Check](./concepts/funding-check.md) (on Solana, including the SOL for fees and new token-account rent, [ADR-0043](./adr/0043-the-funding-check-counts-what-sending-costs.md)), or refused by the chain. `chainDetail` is `{ asset, short }`, and for a Multisig Sender also `holder`, `address` and `committed`. |
| `INVALID_RECIPIENT` | A malformed or unusable address: a recipient, or a Bulk Call aggregator with no contract code. |
| `UNKNOWN_ASSET` | A `payment`'s `asset` has no configured encoding on this chain ([ADR-0029](./adr/0029-unknown-asset-error-code.md)). |
| `CHAIN_REJECTED` | The chain definitely refused or reverted it, or a request was invalid for this chain: a wrong chain ID, a bad signature, malformed calldata, a Bulk Call rule. For a Multisig Sender also: a Call it cannot put in a Proposal, a Safe Transaction Service refusal (a 401 key or a 422 for an unregistered delegate), or a Safe execute whose simulation fails (`GS013`). |
| `RPC_UNAVAILABLE` | The chain's RPC couldn't be reached or answered: a timeout, a rate limit, a 5xx. |
| `SIGNER_UNREACHABLE` | The Signer couldn't be reached or returned an unusable signature. |
| `SIGNER_REFUSED` | The Signer refused to sign it under its policy ([ADR-0046](./adr/0046-the-signer-sees-the-whole-transaction-and-can-refuse-it.md)). Definite: the item is `failed` and never retried. `message` carries the Signer's reason. |
| `CHAIN_NOT_ENABLED` | The request names a chain this deployment hasn't enabled in `ENABLED_CHAINS` ([ADR-0019](./adr/0019-chains-activated-by-config-not-code.md)). |
| `NONCE_ALREADY_USED` | The transaction's nonce was already consumed on chain (Base). |
| `APPROVAL_REJECTED` | A Multisig Sender's Proposal was rejected or cancelled by its Approvers before its deadline, or went stale (on Safe: its nonce was taken by a different transaction). Definite: the item is `failed`, with `transactionHash: null` ([ADR-0049](./adr/0049-the-engine-proposes-and-executes-multisig-transactions-but-never-approves.md), [ADR-0054](./adr/0054-multisig-approval-is-a-chain-handler-capability-and-a-proposal-never-mixes-dispatches.md)). `chainDetail` is `{ "status": "rejected" }`, `"cancelled"` or `"stale"` when the watch after a timeout raised it. A Safe whose nonce was taken by another transaction reports `rejected`. |
| `APPROVAL_TIMEOUT` | Nobody decided on the Proposal by its `deadline`. The item is `abandoned`, not `failed` ([ADR-0053](./adr/0053-a-multisig-proposal-nobody-decided-on-is-abandoned-and-watched.md)): the Proposal may still be approved and executed by someone else, so a caller must check before sending again. `chainDetail` is `{ "deadlineAt": "<ISO 8601>" }`. |
| `ALREADY_CLAIMED` | Only from the cancel route, with `409`: the engine already claimed the Dispatch. |

One more code exists inside the engine, `ALREADY_KNOWN`: the node already has these exact bytes. It is never reported. It means the transaction was sent, so the item stays `broadcasting` until it resolves.

## Not in the API yet

- Webhooks ([ADR-0023](./adr/0023-polling-required-webhooks-later.md)). Polling is the way to get a result for now.
- Ethereum L1, a separate future chain that is not designed yet, and not "the rest of EVM" ([ADR-0035](./adr/0035-base-and-ethereum-are-separate-chains.md)).
