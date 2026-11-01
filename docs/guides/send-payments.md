# Send a batch of payments

This guide pays several recipients in one Dispatch, waits for the result, and sends the payments that failed again. The example pays 0.00005 ETH and 40 USDC on Base Sepolia from a Sender that holds ETH but no USDC, so you also see what a shortfall looks like. Solana works the same way with `"chain": "solana"` and `SOL`.

You need a running engine with the chain enabled. The [Quickstart](../quickstart.md) sets one up.

## 1. Check that the Sender can pay

The engine checks the balance only after it claims the Dispatch, so check first. [List Senders](../openapi.yaml#list-senders) shows each Sender's balance per asset:

```sh
curl -s "$DISPATCH_URL/v1/senders" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

For the Base Sender here, `balances[0].assets` reads:

```jsonc
[
  { "asset": "ETH", "decimals": 18, "balance": "5692964363506001", "committed": "0" },
  { "asset": "USDC", "decimals": 6, "balance": "0", "committed": "0" }
]
```

The Sender has about 0.0057 ETH and no USDC. [Read Sender balances before you send](./sender-balances.md) turns this into a check you can run before every batch.

## 2. Write the items

Each payment names a `recipient`, an `asset` and an `amount` in the asset's smallest unit, as a string:

- `"50000000000000"` wei is 0.00005 ETH.
- `"40000000"` is 40 USDC, which has 6 decimals.

`ETH` and `SOL` always work. A token works only if it is an enabled Known Asset (`GET /v1/assets`): listed in `BASE_KNOWN_TOKENS` or `SOLANA_KNOWN_TOKENS`, or added by the operator with `POST /v1/assets`. Otherwise the request is refused with `UNKNOWN_ASSET` and nothing is stored.

A Dispatch can hold thousands of items, up to a 1 MiB body. Each item gets its own status. On Solana the engine packs several payments into one transaction. On Base it sends one transaction per payment, in nonce order. To bundle Base payments into fewer transactions, see [Batch payments into one transaction on Base](./bulk-call.md).

## 3. Choose an Idempotency-Key

Take the key from your own records, such as the payroll run or the invoice batch the payments come from. If your request times out and you send it again with the same key, the engine returns the Dispatch it already created instead of paying twice.

## 4. Submit the Dispatch

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: payroll-2026-11-01" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "base",
    "items": [
      { "type": "payment", "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72", "asset": "ETH", "amount": "50000000000000" },
      { "type": "payment", "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72", "asset": "USDC", "amount": "40000000" }
    ]
  }'
```

```json
{ "dispatchId": "1a2f3f9f-0e2e-461c-b12c-e31391f1d5b4", "status": "queued" }
```

`202` means the engine stored the Dispatch. It says nothing about the balance or the chain yet.

If the operator configured several Senders on the chain, add `"sender": "<name>"` to pay from one of them. [List Senders](../openapi.yaml#list-senders) shows each Sender's `name` and which is the `default`. Without `sender`, the chain's default Sender pays. A name the chain does not have is refused with `UNKNOWN_SENDER`, and nothing is stored.

## 5. Poll until it is final

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "1a2f3f9f-0e2e-461c-b12c-e31391f1d5b4",
  "mode": "managed",
  "chain": "base",
  "createdAt": "2026-11-01T02:12:17.619Z",
  "status": "partial",
  "items": [
    {
      "type": "payment",
      "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "asset": "ETH",
      "decimals": 18,
      "amount": "50000000000000",
      "status": "confirmed",
      "transactionHash": "0x7e00aec4eafe72c4c852ff1517ddc1492b4581f117e9a9bbd88602f674735896",
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

The items come back in the order you sent them, each with its own status. `partial` means every item is final and some, but not all, are `confirmed`. [Polling for results](../polling.md) has a loop you can reuse.

## 6. Send the failed payments again

The ETH payment landed. The USDC payment failed the Funding Check before anything was signed, so `transactionHash` is `null` and nothing left the Sender. `chainDetail.short` is how much more the Sender needs: 40000000, or 40 USDC.

1. Top up the Sender by at least `short`.
2. Send only the failed items, in a new Dispatch with a new key, such as `payroll-2026-11-01-retry-1`. The old key returns the old Dispatch.

Never send again an item that is `broadcasting`, and check the chain first for one that is `abandoned`. [Errors](../errors.md#error-codes) says what to do about each code.

## Next steps

- [Track a Dispatch to confirmation](./track.md) and read its timeline.
- [Call a contract or program](./call-a-contract.md) in the same Dispatch as your payments.
