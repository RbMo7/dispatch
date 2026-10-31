# Your first Dispatch, line by line

This page takes the payment from the [Quickstart](./quickstart.md) apart: what each line of the request means, what the engine does with it, and how to read the answers. The examples are the Base payment from that guide. The Solana one reads the same way.

## The request

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: quickstart-base-001" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "base",
    "items": [
      {
        "type": "payment",
        "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
        "asset": "ETH",
        "amount": "100000000000000"
      }
    ]
  }'
```

```json
{ "dispatchId": "cfd579de-2909-4ee5-ba4c-64e08db93040", "status": "queued" }
```

`POST /v1/dispatch` creates a Dispatch: one request carrying one or more things to send on one chain.

`Authorization: Bearer $DISPATCH_TOKEN` is the engine's API token, the `AUTH_TOKEN` you set in `.env`. Every `/v1` route needs it. There is one token per engine, with no users or scopes ([ADR-0022](./adr/0022-single-api-key-auth.md)), so treat it like a database password.

`Idempotency-Key: quickstart-base-001` makes the request safe to repeat. If your client times out and sends the same request again with the same key, the engine returns the Dispatch it already created instead of paying twice. The key is required, and it is global to the engine. A good key comes from your own records, such as an invoice number or a payroll run id ([ADR-0021](./adr/0021-idempotency-key-required.md)).

`"chain": "base"` picks the chain. It must be one of the chains in `ENABLED_CHAINS`. Which network that means, Base Sepolia or Base mainnet, is the engine's configuration (`BASE_RPC_URL` and `BASE_CHAIN_ID`), not the request's.

`"items"` is the list of things to send. This one has a single item. A Dispatch can hold hundreds, and each gets its own status.

`"type": "payment"` is a plain transfer: an asset, an amount, a recipient. The other type, `call`, is a contract call you encode yourself. [Calls and Payments](./concepts/calls-and-payments.md) compares them.

`"recipient"` is the address that receives the payment. It only needs to be a valid address. The recipient needs no Signer and no account with the engine.

`"asset": "ETH"` is the native asset. A token payment names the token's symbol, such as `USDC`, and the operator has to list the token in `BASE_KNOWN_TOKENS` or `SOLANA_KNOWN_TOKENS` first. An asset that is not listed is refused with `UNKNOWN_ASSET`.

`"amount": "100000000000000"` is 0.0001 ETH, written in wei, the asset's smallest unit. Amounts are always whole numbers in a string. A string holds 18-decimal amounts exactly where a JSON number would round them, and a whole number in the smallest unit leaves nothing to interpret. `"0.0001"` is refused with a `400`.

The answer is `202 Accepted` with the new Dispatch's id and `status: "queued"`. The engine has stored the request and nothing more. It has not checked the balance, signed anything or touched the chain. The answer never carries a chain result, so every caller polls for one.

## What the engine does next

The worker looks for queued Dispatches every two seconds, between rounds of work. When it claims yours:

1. The **Funding Check** adds up what the Dispatch needs per asset, plus the fees, and compares that with the Sender's balance. A shortfall fails the affected items now with `INSUFFICIENT_FUNDS`, before anything is signed ([Funding Check](./concepts/funding-check.md)).
2. The worker builds the transaction and assigns its nonce.
3. The Signer signs it, if the key's policy allows it.
4. The worker writes the signed transaction and its hash to Postgres **before** sending it. A crash after this point can never lose track of a transaction that might land ([ADR-0041](./adr/0041-transactions-are-noted-before-they-are-sent.md)).
5. It sends the transaction, then checks it until the chain answers. A send whose result is unknown, such as an RPC timeout, is checked again rather than reported as failed.

## Polling for the result

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "cfd579de-2909-4ee5-ba4c-64e08db93040",
  "mode": "managed",
  "status": "confirmed",
  "items": [
    {
      "type": "payment",
      "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "asset": "ETH",
      "decimals": 18,
      "amount": "100000000000000",
      "status": "confirmed",
      "transactionHash": "0xc45a587722caedff3ceb01804d121eb746463f30a79f13fe42d79fd8264c5bb3",
      "error": null
    }
  ]
}
```

`"mode": "managed"` says the engine built and signed this transaction. A Dispatch of a transaction someone else signed reads `"relay"` and has a different shape ([Managed and Relay Dispatch](./concepts/managed-and-relay.md)).

The top-level `"status"` sums up the items. `confirmed` means every item landed. Before that you see `queued` and then `broadcasting`. If some items land and others fail, the Dispatch is `partial`. If none land, it is `failed`.

Each item repeats what you asked for, in the order you sent it, and adds `decimals`. Divide `amount` by 10 to the power of `decimals` to get whole ETH. The engine fills `decimals` in from its own configuration, so a client can show amounts without its own token table.

The item's `"status"` is that item's own progress. Items have a few more states than the Dispatch, such as `abandoned` and `awaiting_approval`. [Statuses](./concepts/statuses.md) lists them all and says what each means for your code.

`"transactionHash"` is the transaction that carries this item. It is `null` until the transaction is signed. On Solana several items can share one hash, because the engine packs several payments into one transaction.

`"error"` is `null` unless the item failed or was abandoned. Then it is an object with a `code` you can switch on, a `message` for people, and sometimes a `chainDetail` with the raw detail. Here is a real failure from a Dispatch that paid 0.00005 ETH and 40 USDC from a Sender with no USDC:

```json
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
```

The ETH item of that Dispatch confirmed, so its top-level status was `partial`. `transactionHash` is `null` because the Funding Check failed the item before anything was signed.

## Seeing every step

Add `?include=timeline` to see what happened and when:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID?include=timeline" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "cfd579de-2909-4ee5-ba4c-64e08db93040",
  "mode": "managed",
  "status": "confirmed",
  "items": [
    {
      "type": "payment",
      "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "asset": "ETH",
      "decimals": 18,
      "amount": "100000000000000",
      "status": "confirmed",
      "transactionHash": "0xc45a5877…5bb3",
      "error": null
    }
  ],
  "timeline": [
    { "kind": "created", "at": "2026-10-31T18:48:27.961Z" },
    { "kind": "claimed", "at": "2026-10-31T18:48:31.952Z" },
    { "kind": "written", "at": "2026-10-31T18:48:31.999Z", "hash": "0xc45a5877…5bb3", "items": [0], "replaces": null },
    { "kind": "sent", "at": "2026-10-31T18:48:32.270Z", "hash": "0xc45a5877…5bb3", "items": [0] },
    { "kind": "confirmed", "at": "2026-10-31T18:48:39.847Z", "hash": "0xc45a5877…5bb3", "items": [0] }
  ]
}
```

Read it top to bottom. The API stored the Dispatch, the worker claimed it four seconds later, the signed transaction was written down, the node accepted it 271 milliseconds after that, and the chain confirmed it seven and a half seconds later. A fee bump, a resend or an approval vote shows up here as more entries. [`GET /v1/dispatch/:id`](./api/get-dispatch.md#see-every-step-with-includetimeline) lists every kind.

## Sending it again

Send the same request with the same `Idempotency-Key` and you get the same Dispatch back, in its current state, with `202`. Nothing new is created and nothing is paid twice. To pay the same recipient again on purpose, use a new key.

## Next

- [Statuses](./concepts/statuses.md): what to do about each one
- [`POST /v1/dispatch`](./api/create-dispatch.md): every field the request takes
- [Set up a production Signer](./signer.md)
