# Call a contract or program

A `payment` item covers a transfer. For anything else, such as calling your own contract, minting, or writing a memo, send a `call` item: the destination and the data, encoded by you. The engine signs it with the Sender's key and sends it without interpreting it. You own the ABI or the IDL.

This guide sends a call on each chain and mixes a call with a payment in one Dispatch.

## 1. Encode the call

A call has the shape of the chain's own instruction:

| Chain | Fields |
| --- | --- |
| `base` | `to`: the contract or address. `data`: the calldata as `0x` hex, `0x` for none. `value`: the wei to send with it, as a string. |
| `solana` | `programId`: the program. `accounts`: its accounts, in order, each `{ "pubkey", "isSigner", "isWritable" }`. `data`: the instruction data, base64. |

On Base, encode calldata with your usual library. With viem:

```js
import { encodeFunctionData, parseAbi } from 'viem';

const data = encodeFunctionData({
  abi: parseAbi(['function transfer(address to, uint256 amount)']),
  functionName: 'transfer',
  args: ['0x8ba1f109551bD432803012645Ac136ddd64DBA72', 40000000n],
});
console.log(data);
```

On Solana, `data` is the instruction's bytes in base64. The Memo program takes UTF-8 text, so the memo `invoice 4471` is `aW52b2ljZSA0NDcx`:

```sh
printf 'invoice 4471' | base64
```

The engine signs only with the Sender's key. A Solana instruction that needs any other account to sign cannot be completed by the engine.

## 2. Send a call on Base

A call with empty calldata and a `value` is a plain ETH transfer written as a call:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: call-base-2026-11-01" \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","items":[{"type":"call","to":"0x8ba1f109551bD432803012645Ac136ddd64DBA72","data":"0x","value":"20000000000000"}]}'
```

```json
{ "dispatchId": "e9dd9112-3da8-40e7-98e3-2bc34fb11a40", "status": "queued" }
```

## 3. Mix a call and a payment on Solana

One Dispatch can hold both. This one writes the memo and pays 0.0025 SOL:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: invoice-4471" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "solana",
    "items": [
      { "type": "call", "programId": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "accounts": [], "data": "aW52b2ljZSA0NDcx" },
      { "type": "payment", "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2", "asset": "SOL", "amount": "2500000" }
    ]
  }'
```

```json
{ "dispatchId": "5757b997-07b6-4f94-a7f8-80e85ba8d43c", "status": "queued" }
```

## 4. Read it back

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "5757b997-07b6-4f94-a7f8-80e85ba8d43c",
  "mode": "managed",
  "chain": "solana",
  "createdAt": "2026-11-01T02:12:17.641Z",
  "status": "confirmed",
  "items": [
    {
      "type": "call",
      "programId": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
      "status": "confirmed",
      "transactionHash": "9E9bsn8mMj9kEF37tMQ99CqGMkybEryqNaC7SNcaE8htBPBkRcnVefFzWueJ7MHWZXZrHDRjJDNYTE3WZpqpizW",
      "error": null
    },
    {
      "type": "payment",
      "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
      "asset": "SOL",
      "decimals": 9,
      "amount": "2500000",
      "status": "confirmed",
      "transactionHash": "9E9bsn8mMj9kEF37tMQ99CqGMkybEryqNaC7SNcaE8htBPBkRcnVefFzWueJ7MHWZXZrHDRjJDNYTE3WZpqpizW",
      "error": null
    }
  ]
}
```

A call item shows its `type` and its target, `to` on Base or `programId` on Solana. Its data, value and accounts are left out. On Solana both items went out in one transaction, so they share a hash.

## What the engine checks, and what it does not

- **The shape, at submission.** A malformed call is a `400` with `CHAIN_REJECTED` and nothing is stored, for example `call data is not a well-formed (whole-byte) hex string: hello`.
- **Not what the call does.** A call that reverts fails on the chain, and the item is `failed` with `CHAIN_REJECTED`. `message` has the node's words and `chainDetail` the revert data.
- **Not what the call spends.** The [Funding Check](../lifecycle.md#the-funding-check) counts payments, not calls, not even a Base call's `value`. Make sure the Sender holds enough for your calls yourself.

Prefer a `payment` whenever you are moving money. The engine knows what a payment does, so it can check the balance first, the Signer's policy can count it against a cap, and a Multisig Sender can propose it.

## Where calls are refused

- **A Multisig Sender** proposes only native and known-token transfers. Any other call is refused at submission with `400 CHAIN_REJECTED` naming the item, such as `items[1]: …`. [Pay from a multisig](./multisig.md) explains why.
- **A Signer policy** with `allowedDestinations` refuses a call to a contract or program it does not list. It also refuses calls to a capped token other than `transfer`, such as `approve`. The item is `failed` with `SIGNER_REFUSED`.
