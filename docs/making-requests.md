# Making requests

The API is JSON over HTTP. This page covers what every request has in common: where to send it, how to write amounts and addresses, and how to make a request safe to repeat.

## The base URL

The API listens on port 8420 by default, set by `PORT`. On your machine the base URL is `http://localhost:8420`. In a deployment it is wherever you serve the API process, behind TLS.

Every example in these docs reads two environment variables, so you can paste them as they are:

```sh
export DISPATCH_URL=http://localhost:8420
export DISPATCH_TOKEN=<your AUTH_TOKEN>
```

The routes are versioned under `/v1`. The [REST API reference](./openapi.yaml#create-a-dispatch) lists each one.

## JSON in, JSON out

Send a JSON body with `Content-Type: application/json`. Every answer is JSON, errors included. `POST /v1/dispatch/{id}/cancel` takes no body.

A Managed Dispatch body accepts only the fields the reference lists. An unknown field, such as a misspelled `retryPolicy`, is a `400`, not a field quietly ignored. Query parameters the reference does not list are ignored.

A request body can be up to 1 MiB. That holds about 9,000 payment items. A larger body gets `413`, so split a larger run into several Dispatches.

The API has no rate limit of its own. The limits that matter are your RPC provider's.

## Amounts are whole numbers in a string

Every amount is a whole number of the asset's smallest unit, written as a string:

| Asset | Smallest unit | `"1250000"` means |
| --- | --- | --- |
| `ETH` | wei, 18 decimals | 0.00000000000125 ETH |
| `SOL` | lamport, 9 decimals | 0.00125 SOL |
| `USDC` | 6 decimals | 1.25 USDC |

A string holds an 18-decimal amount exactly where a JSON number would round it, and a whole number leaves nothing to interpret. `"12.5"` is refused with `400` and `items[0]: amount must be a non-negative integer string`.

When you read a Dispatch back, each payment item carries `decimals`, the asset's decimal places from its Known Asset record (`GET /v1/assets`). Divide `amount` by 10 to the power of `decimals` to show it to people. A token is known to the engine when the operator lists it in `BASE_KNOWN_TOKENS` or `SOLANA_KNOWN_TOKENS`, or adds it with `POST /v1/assets`, which reads its decimals from the chain.

## Addresses

On Base, an address is `0x` and 40 hex characters. A mixed-case address must have a valid checksum. On Solana, an address is a base58 public key. A malformed recipient is refused with `400` and `INVALID_RECIPIENT`, and nothing is stored.

Which network a chain means, test or main, is the engine's configuration (`BASE_CHAIN_ID`, `SOLANA_RPC_URL`), never the request's. [List Senders](./openapi.yaml#list-senders) reports it as `network`.

## Make a request safe to repeat with an Idempotency-Key

`POST /v1/dispatch` requires an `Idempotency-Key` header. If your client times out and sends the same request again with the same key, the engine returns the Dispatch it already created, in its current state, with `202`, instead of paying twice.

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: quickstart-base-001" \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","items":[{"type":"payment","recipient":"0x8ba1f109551bD432803012645Ac136ddd64DBA72","asset":"ETH","amount":"100000000000000"}]}'
```

```json
{ "dispatchId": "74192aa6-2141-477f-bba2-57d5004cbf88", "status": "broadcasting" }
```

That Dispatch was the Quickstart's, already confirmed on chain. The answer's `status` is the stored one, which only ever reads `queued`, `broadcasting` or `cancelled`. For the outcome of each item, call [Get a Dispatch](./openapi.yaml#get-a-dispatch).

The key is the whole match. These rules follow from that:

- **Keys are global to the engine.** Derive them from your own records, such as an invoice number or a payroll run id, so two callers never pick the same one by chance.
- **The body is not compared.** A second request with the same key gets the first Dispatch back, even if its body differs. To send something new, use a new key.
- **A refused request does not use up its key.** A `400` stores nothing, so you can fix the request and send it again with the same key.
- **A failed or cancelled Dispatch keeps its key.** Sending the key again returns that Dispatch's id and creates nothing. To retry the payments, send them in a new Dispatch with a new key.
- **Managed and Relay Dispatches keep separate keys.** One key can name one of each.

## Next steps

- [Errors](./errors.md): every error shape and code, and what to do about each.
- [Polling for results](./polling.md): how often to ask, and when to stop.
