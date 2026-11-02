# Send a transaction your user already signed

Use a Relay Dispatch when someone other than the engine signs: a user's wallet in your app, a hardware wallet, another service. The engine broadcasts the signed bytes, resends them if they stall, and tracks them to an outcome. It never sees the key.

| | Managed Dispatch | Relay Dispatch |
| --- | --- | --- |
| Who signs | Your Signer, with the Sender's key | Whoever made the transaction |
| You send | `items`: payments and calls | `signedTransaction`: base64, or `0x` hex on Base |
| Nonce | The engine assigns it | Already in the signed bytes |
| Batching | Yes | One transaction |
| Fee bump on Base | With `retryPolicy: true` | Never |
| Expired Solana blockhash | Rebuilt and resent, up to 3 times | `failed` |
| Funding Check | Yes | No |
| Status | Top level plus one per item | Top level only |

Both kinds share the endpoint, the headers, the `Idempotency-Key` rules, the list and the cancel routes.

## 1. Get a signed transaction

Your user signs the transaction in their wallet, and your app serializes it. The engine accepts:

- **Base:** an EIP-1559 (type `0x02`) transaction for the engine's `BASE_CHAIN_ID`, with a low-s signature, as `0x` hex or base64. Every common wallet library produces this by default.
- **Solana:** a legacy or versioned (v0) transaction with every required signature, as base64.

For a test, this script signs one of each from keys you hold. In a real app the wallet does the signing, and only the last line of each half matters: the serialized bytes you send to the engine.

```js
// sign-relay.mjs. Needs: npm i viem @solana/web3.js
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

// Base Sepolia: send 0.00003 ETH.
const account = privateKeyToAccount(process.env.BASE_TEST_KEY);
const client = createPublicClient({ chain: baseSepolia, transport: http() });
const fees = await client.estimateFeesPerGas();
const baseTx = await account.signTransaction({
  chainId: 84532,
  type: 'eip1559',
  to: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
  value: 30000000000000n,
  nonce: await client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
  gas: 21000n,
  maxFeePerGas: fees.maxFeePerGas * 2n,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
});
console.log('base', baseTx);

// Solana devnet: send 0.005 SOL.
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.SOLANA_TEST_KEYPAIR, 'utf8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const { blockhash } = await connection.getLatestBlockhash();
const solanaTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(
  SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: new PublicKey('Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2'),
    lamports: 5000000,
  }),
);
solanaTx.sign(payer);
console.log('solana', solanaTx.serialize().toString('base64'));
```

A Solana transaction is valid only until its blockhash expires, about a minute after `getLatestBlockhash`. Send it to the engine at once.

## 2. Send it

Put the bytes in `signedTransaction` and set `"mode": "relay"`. The body takes nothing else: no `items`, no `retryPolicy`, no `bulkCall`. Sending any of them is a `400`.

```sh title="Base"
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: relay-order-8841" \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","mode":"relay","signedTransaction":"0x02f87183014a3480830f424083d59f80825208948ba1f109551bd432803012645ac136ddd64dba72861b48eb57e00080c001a02c2bc48c3fcabc9f5ea48fb0ee592480f25b957f0ccda68374bb34bb70719e62a0610f05e4780b00923708bd656935e31968d8ca6f21a0c326678105c5b13f54a3"}'
```

```sh title="Solana"
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: relay-order-8842" \
  -H "Content-Type: application/json" \
  -d '{"chain":"solana","mode":"relay","signedTransaction":"AfP25/Piq4hD7uKt5vhz4b5QntZw1rvNcJbRWhIoWrirJzCgl7299/SD7DWex9URbl+KhV9n7QiKR5iwM8LsfAoBAAEDHntsSEO3GyebSN8MUQyX06Ws4Taqnwsfzlq2Fqrbze69xvb1VVXvEsuYM2vL94stXfe/jNYCJlYL29F5kB85UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKPrcgScoX1f/WGmGI/bmUdz01PT6t/xstWyS4R/+owYBAgIAAQwCAAAAQEtMAAAAAAA="}'
```

```json title="Base"
{ "dispatchId": "155d989f-0439-4c1c-ac75-68b2204b9d92", "status": "queued" }
```

```json title="Solana"
{ "dispatchId": "78dbeb88-ec45-4e73-bf74-f71434302ba4", "status": "queued" }
```

The engine decodes the bytes and checks the signatures and the chain ID before it stores anything. Bytes it cannot read are a `400` with `CHAIN_REJECTED`, such as `not a decodable signed transaction`.

Use an `Idempotency-Key` tied to the user's action, such as the order id, so a retry from your app never relays twice.

## 3. Poll for the result

A Relay Dispatch reports one status at the top level, with its hash and error beside it:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "78dbeb88-ec45-4e73-bf74-f71434302ba4",
  "mode": "relay",
  "chain": "solana",
  "createdAt": "2026-11-01T02:13:05.098Z",
  "status": "confirmed",
  "transactionHash": "5suMQ69pdMQgSMWUaHQBcrJ8ydto3tUFhfQPN4VXiWSPFvrjvkM2TVGUjfePRxQ1pxe1LWqgFkEXXQnTU5Z8KJkh",
  "error": null
}
```

Its status is one of `queued`, `broadcasting`, `confirmed`, `failed`, `abandoned` or `cancelled`. With `include=timeline`, its one transaction is item `0`.

## What the engine cannot do for you

The engine holds no key for a Relay Dispatch, so:

- **A stuck Base transaction is resent, never repriced.** If it stays unconfirmed for 15 minutes it is `abandoned`. Your user can sign a replacement at the same nonce with a higher fee, and you relay that as a new Dispatch. Only one of the two can land.
- **An expired Solana transaction is `failed`.** The engine cannot refresh the blockhash. Ask the user to sign again.
- **No balance check.** If the payer cannot cover the transaction, the chain refuses it and the status is `failed` with the chain's reason.
- **No Signer policy.** The Signer is not involved, so its policy does not apply.

You can cancel a Relay Dispatch the same way as a Managed one, only before the worker claims it. [Cancel a Dispatch](./cancel.md) has the rules.
