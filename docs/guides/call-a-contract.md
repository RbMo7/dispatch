# Call a contract or program

A `payment` item covers a transfer. For anything else, such as calling your own contract, minting, or writing a memo, send a `call` item: the destination and the data, encoded by you. The engine signs it with the Sender's key and sends it. When it reads the Dispatch back, it tells you what the call does and, once it is confirmed, what it changed on chain.

This guide sends calls on both chains and reads both answers back.

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
  abi: parseAbi(['function deposit(string note) payable']),
  functionName: 'deposit',
  args: ['invoice 4471'],
});
console.log(data);
```

On Solana, `data` is the instruction's bytes in base64. The Memo program takes UTF-8 text, so the memo `invoice 4471` is `aW52b2ljZSA0NDcx`:

```sh
printf 'invoice 4471' | base64
```

The engine signs only with the Sender's key. A Solana instruction that needs any other account to sign cannot be completed by the engine.

## 2. Send calls on Base

This Dispatch makes two calls. The first moves 1.5 of an ERC-20 token by calling its `transfer`. The second calls `deposit("invoice 4471")` on a vault contract and sends 0.000001 ETH with it:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: vault-deposit-4471" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "base",
    "items": [
      { "type": "call", "to": "0x6e25d1D86c15a7D5d1503C2df414304B7D2c9cce", "data": "0xa9059cbb0000000000000000000000008ba1f109551bd432803012645ac136ddd64dba72000000000000000000000000000000000000000000000000000000000016e360", "value": "0" },
      { "type": "call", "to": "0xbB7d2b970A48c03ed02238dAdcA3a1e6B1C49867", "data": "0xa26e11860000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000c696e766f69636520343437310000000000000000000000000000000000000000", "value": "1000000000000" }
    ]
  }'
```

```json
{ "dispatchId": "c5710ef6-0886-4232-b906-15e0cf0adfd9", "status": "queued" }
```

On Base each call is its own transaction, unless you use [Bulk Call](./bulk-call.md).

## 3. Read back what the calls did

[Get a Dispatch](../openapi.yaml#get-a-dispatch) shows each call item's target and a `call` block. Once the item is confirmed, the worker reads its transaction from the chain once, a few seconds later, and the item gains `effects`:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "c5710ef6-0886-4232-b906-15e0cf0adfd9",
  "mode": "managed",
  "chain": "base",
  "sender": { "name": "payouts", "address": "0x65a57ff11d4E6025922074Ba6dBe89FA8add150e" },
  "createdAt": "2026-11-01T17:32:59.300Z",
  "status": "confirmed",
  "items": [
    {
      "type": "call",
      "to": "0x6e25d1D86c15a7D5d1503C2df414304B7D2c9cce",
      "call": {
        "target": "0x6e25d1D86c15a7D5d1503C2df414304B7D2c9cce",
        "decoded": true,
        "decoder": "erc20",
        "function": "transfer",
        "args": [
          { "name": "to", "type": "address", "value": "0x8ba1f109551bD432803012645Ac136ddd64DBA72" },
          {
            "name": "amount",
            "type": "uint256",
            "value": "1500000",
            "asset": {
              "address": "0x6e25d1D86c15a7D5d1503C2df414304B7D2c9cce",
              "symbol": "FLOW",
              "name": "FLOW",
              "decimals": 6
            },
            "formatted": "1.5"
          }
        ],
        "selector": "0xa9059cbb"
      },
      "status": "confirmed",
      "transactionHash": "0xe52b060adfc5d0bf6b416031ac1df30d851246df8cd8cfc5cebf2b230756337d",
      "error": null,
      "effects": {
        "transfers": [
          {
            "standard": "erc20",
            "token": "0x6e25d1D86c15a7D5d1503C2df414304B7D2c9cce",
            "from": "0x65a57ff11d4E6025922074Ba6dBe89FA8add150e",
            "to": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
            "amount": "1500000",
            "asset": {
              "address": "0x6e25d1D86c15a7D5d1503C2df414304B7D2c9cce",
              "symbol": "FLOW",
              "name": "FLOW",
              "decimals": 6
            },
            "formatted": "1.5"
          }
        ],
        "fee": {
          "amount": "314160000095",
          "asset": { "address": "native", "symbol": "ETH", "name": "Ether", "decimals": 18 },
          "formatted": "0.000000314160000095",
          "payer": "0x65a57ff11d4E6025922074Ba6dBe89FA8add150e"
        },
        "events": [
          {
            "kind": "log",
            "source": "0x6e25d1D86c15a7D5d1503C2df414304B7D2c9cce",
            "decoder": "erc20",
            "name": "Transfer",
            "args": [
              { "name": "from", "type": "address", "value": "0x65a57ff11d4E6025922074Ba6dBe89FA8add150e" },
              { "name": "to", "type": "address", "value": "0x8ba1f109551bD432803012645Ac136ddd64DBA72" },
              {
                "name": "value",
                "type": "uint256",
                "value": "1500000",
                "asset": {
                  "address": "0x6e25d1D86c15a7D5d1503C2df414304B7D2c9cce",
                  "symbol": "FLOW",
                  "name": "FLOW",
                  "decimals": 6
                },
                "formatted": "1.5"
              }
            ]
          }
        ],
        "undecodedEvents": 0,
        "undecodedEventSources": [],
        "truncated": false
      }
    },
    {
      "type": "call",
      "to": "0xbB7d2b970A48c03ed02238dAdcA3a1e6B1C49867",
      "call": {
        "target": "0xbB7d2b970A48c03ed02238dAdcA3a1e6B1C49867",
        "value": {
          "amount": "1000000000000",
          "asset": { "address": "native", "symbol": "ETH", "name": "Ether", "decimals": 18 },
          "formatted": "0.000001"
        },
        "decoded": false,
        "selector": "0xa26e1186",
        "data": "0xa26e11860000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000c696e766f69636520343437310000000000000000000000000000000000000000"
      },
      "status": "confirmed",
      "transactionHash": "0x4218b8a1b5b82284ae37e5f83561920333e2bffc9c2667912ec26de5bdee3b00",
      "error": null,
      "effects": {
        "transfers": [
          {
            "standard": "native",
            "token": "native",
            "from": "0x65a57ff11d4E6025922074Ba6dBe89FA8add150e",
            "to": "0xbB7d2b970A48c03ed02238dAdcA3a1e6B1C49867",
            "amount": "1000000000000",
            "asset": { "address": "native", "symbol": "ETH", "name": "Ether", "decimals": 18 },
            "formatted": "0.000001"
          }
        ],
        "value": {
          "amount": "1000000000000",
          "asset": { "address": "native", "symbol": "ETH", "name": "Ether", "decimals": 18 },
          "formatted": "0.000001"
        },
        "fee": {
          "amount": "148374000095",
          "asset": { "address": "native", "symbol": "ETH", "name": "Ether", "decimals": 18 },
          "formatted": "0.000000148374000095",
          "payer": "0x65a57ff11d4E6025922074Ba6dBe89FA8add150e"
        },
        "events": [],
        "undecodedEvents": 1,
        "undecodedEventSources": [{"source": "0xbB7d2b970A48c03ed02238dAdcA3a1e6B1C49867", "count": 1}],
        "truncated": false
      }
    }
  ]
}
```

The two items show the two cases.

- **Item 0 is decoded.** The ERC-20 decoder knows `transfer`, so `call` names the `function` and its `args`. The token is a Known Asset, so the amount also carries `asset` and `formatted`, the amount in whole units. Its `effects.events` holds the `Transfer` log, decoded the same way.
- **Item 1 is not decoded.** No built-in decoder knows the vault, so `call` has `decoded: false`, the 4-byte `selector` and the raw `data`. The `value` sent with the call is still shown, and in `effects` it is `value` and a `native` transfer. Its `Deposited` log is counted in `undecodedEvents`, by contract in `undecodedEventSources`.

## 4. Send a program call on Solana

One Dispatch can mix calls and payments. This one writes a memo, sends 0.0025 SOL with a raw System Program `transfer` instruction, and pays 0.001 SOL as a `payment`:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: invoice-4471-solana" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "solana",
    "items": [
      { "type": "call", "programId": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "accounts": [], "data": "aW52b2ljZSA0NDcx" },
      { "type": "call", "programId": "11111111111111111111111111111111", "accounts": [
          { "pubkey": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82", "isSigner": true, "isWritable": true },
          { "pubkey": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2", "isSigner": false, "isWritable": true }
        ], "data": "AgAAAKAlJgAAAAAA" },
      { "type": "payment", "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2", "asset": "SOL", "amount": "1000000" }
    ]
  }'
```

```json
{ "dispatchId": "85e0b511-85a7-4c1b-9747-b59bcde1e72e", "status": "queued" }
```

The first account of the transfer is the Sender, `7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82` here, because only the Sender can sign. `AgAAAKAlJgAAAAAA` is the System Program's instruction 2, `transfer`, followed by 2,500,000 lamports as a little-endian 64-bit number.

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "85e0b511-85a7-4c1b-9747-b59bcde1e72e",
  "mode": "managed",
  "chain": "solana",
  "sender": { "name": "payouts", "address": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
  "createdAt": "2026-11-01T17:32:59.344Z",
  "status": "confirmed",
  "items": [
    {
      "type": "call",
      "programId": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
      "call": {
        "target": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        "decoded": true,
        "decoder": "memo",
        "function": "memo",
        "args": [{"name": "text", "type": "string", "value": "invoice 4471"}]
      },
      "status": "confirmed",
      "transactionHash": "xQVBfLfsrTeHuSE68SBSsSArjJFAu4GgnXYfmuQm29AG1UGc62iCpfo642jEWJk85ZndSjwXwXNi8g4qMUw5vjk",
      "error": null,
      "effects": {
        "transfers": [
          {
            "standard": "native",
            "token": "native",
            "from": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82",
            "to": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
            "amount": "2500000",
            "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
            "formatted": "0.0025"
          },
          {
            "standard": "native",
            "token": "native",
            "from": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82",
            "to": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
            "amount": "1000000",
            "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
            "formatted": "0.001"
          }
        ],
        "fee": {
          "amount": "5000",
          "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
          "formatted": "0.000005",
          "payer": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82"
        },
        "events": [
          {
            "kind": "instruction",
            "source": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            "decoder": "memo",
            "name": "memo",
            "args": [{"name": "text", "type": "string", "value": "invoice 4471"}]
          },
          {
            "kind": "instruction",
            "source": "11111111111111111111111111111111",
            "decoder": "system",
            "name": "transfer",
            "args": [
              { "name": "from", "type": "pubkey", "value": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
              { "name": "to", "type": "pubkey", "value": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2" },
              {
                "name": "lamports",
                "type": "u64",
                "value": "2500000",
                "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
                "formatted": "0.0025"
              }
            ]
          },
          {
            "kind": "instruction",
            "source": "11111111111111111111111111111111",
            "decoder": "system",
            "name": "transfer",
            "args": [
              { "name": "from", "type": "pubkey", "value": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
              { "name": "to", "type": "pubkey", "value": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2" },
              {
                "name": "lamports",
                "type": "u64",
                "value": "1000000",
                "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
                "formatted": "0.001"
              }
            ]
          }
        ],
        "undecodedEvents": 0,
        "undecodedEventSources": [],
        "truncated": false
      }
    },
    {
      "type": "call",
      "programId": "11111111111111111111111111111111",
      "call": {
        "target": "11111111111111111111111111111111",
        "decoded": true,
        "decoder": "system",
        "function": "transfer",
        "args": [
          { "name": "from", "type": "pubkey", "value": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
          { "name": "to", "type": "pubkey", "value": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2" },
          {
            "name": "lamports",
            "type": "u64",
            "value": "2500000",
            "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
            "formatted": "0.0025"
          }
        ],
        "selector": "02000000"
      },
      "status": "confirmed",
      "transactionHash": "xQVBfLfsrTeHuSE68SBSsSArjJFAu4GgnXYfmuQm29AG1UGc62iCpfo642jEWJk85ZndSjwXwXNi8g4qMUw5vjk",
      "error": null,
      "effects": {
        "transfers": [
          {
            "standard": "native",
            "token": "native",
            "from": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82",
            "to": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
            "amount": "2500000",
            "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
            "formatted": "0.0025"
          },
          {
            "standard": "native",
            "token": "native",
            "from": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82",
            "to": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
            "amount": "1000000",
            "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
            "formatted": "0.001"
          }
        ],
        "fee": {
          "amount": "5000",
          "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
          "formatted": "0.000005",
          "payer": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82"
        },
        "events": [
          {
            "kind": "instruction",
            "source": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            "decoder": "memo",
            "name": "memo",
            "args": [{"name": "text", "type": "string", "value": "invoice 4471"}]
          },
          {
            "kind": "instruction",
            "source": "11111111111111111111111111111111",
            "decoder": "system",
            "name": "transfer",
            "args": [
              { "name": "from", "type": "pubkey", "value": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
              { "name": "to", "type": "pubkey", "value": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2" },
              {
                "name": "lamports",
                "type": "u64",
                "value": "2500000",
                "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
                "formatted": "0.0025"
              }
            ]
          },
          {
            "kind": "instruction",
            "source": "11111111111111111111111111111111",
            "decoder": "system",
            "name": "transfer",
            "args": [
              { "name": "from", "type": "pubkey", "value": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
              { "name": "to", "type": "pubkey", "value": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2" },
              {
                "name": "lamports",
                "type": "u64",
                "value": "1000000",
                "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
                "formatted": "0.001"
              }
            ]
          }
        ],
        "undecodedEvents": 0,
        "undecodedEventSources": [],
        "truncated": false
      }
    },
    {
      "type": "payment",
      "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
      "asset": "SOL",
      "decimals": 9,
      "amount": "1000000",
      "status": "confirmed",
      "transactionHash": "xQVBfLfsrTeHuSE68SBSsSArjJFAu4GgnXYfmuQm29AG1UGc62iCpfo642jEWJk85ZndSjwXwXNi8g4qMUw5vjk",
      "error": null,
      "effects": {
        "transfers": [
          {
            "standard": "native",
            "token": "native",
            "from": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82",
            "to": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
            "amount": "2500000",
            "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
            "formatted": "0.0025"
          },
          {
            "standard": "native",
            "token": "native",
            "from": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82",
            "to": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
            "amount": "1000000",
            "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
            "formatted": "0.001"
          }
        ],
        "fee": {
          "amount": "5000",
          "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
          "formatted": "0.000005",
          "payer": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82"
        },
        "events": [
          {
            "kind": "instruction",
            "source": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            "decoder": "memo",
            "name": "memo",
            "args": [{"name": "text", "type": "string", "value": "invoice 4471"}]
          },
          {
            "kind": "instruction",
            "source": "11111111111111111111111111111111",
            "decoder": "system",
            "name": "transfer",
            "args": [
              { "name": "from", "type": "pubkey", "value": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
              { "name": "to", "type": "pubkey", "value": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2" },
              {
                "name": "lamports",
                "type": "u64",
                "value": "2500000",
                "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
                "formatted": "0.0025"
              }
            ]
          },
          {
            "kind": "instruction",
            "source": "11111111111111111111111111111111",
            "decoder": "system",
            "name": "transfer",
            "args": [
              { "name": "from", "type": "pubkey", "value": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
              { "name": "to", "type": "pubkey", "value": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2" },
              {
                "name": "lamports",
                "type": "u64",
                "value": "1000000",
                "asset": { "address": "native", "symbol": "SOL", "name": "Solana", "decimals": 9 },
                "formatted": "0.001"
              }
            ]
          }
        ],
        "undecodedEvents": 0,
        "undecodedEventSources": [],
        "truncated": false
      }
    }
  ]
}
```

The engine packed all three items into one transaction, so they share a `transactionHash` and show the same `effects`. On Solana, `args` list the instruction's accounts first, then its data. `effects.events` lists every instruction the transaction ran, inner ones included.

## What `call` and `effects` hold

`call` is worked out each time you read, from the item's stored data:

| Field | Means |
| --- | --- |
| `target` | The contract (Base) or program (Solana) called. |
| `decoded` | `true` when a decoder named the function, or when the call carries no data. |
| `decoder` | Which built-in decoder read it, such as `erc20` or `spl-token`. |
| `function`, `args` | The function and its arguments, each with `name`, `type` and `value`. Numbers are strings. |
| `selector` | On Base, the 4-byte function selector. On Solana, the instruction's discriminator in hex. |
| `data` | The raw data, only when `decoded` is `false`. |
| `value` | On Base, the ETH sent with the call, when it is not zero. |
| `calls` | For a Multicall3 call, each inner call, decoded the same way. |

`effects` is stored once, when the worker reads the confirmed transaction:

| Field | Means |
| --- | --- |
| `transfers` | Value that moved: native coin, ERC-20, ERC-721, ERC-1155, SPL and Token-2022. `from` is `null` for a mint, `to` is `null` for a burn. |
| `value` | On Base, the ETH the transaction itself sent, when it is not zero. |
| `fee` | What the transaction cost, and the `payer`. On Base it includes the L1 data fee. |
| `events` | Every log (Base) or instruction (Solana) a decoder knows. |
| `undecodedEvents`, `undecodedEventSources` | How many logs or instructions no decoder knows, and where they came from. |
| `truncated` | `true` when part of the transaction was too large to store: past 128 logs or instructions, 2 KiB of data each, or 100 log lines. |

A failed item has no `effects`. A Relay Dispatch gets `effects` at the top level. On Base, ETH that a contract forwards inside the call is not a transfer, because no log records it.

## What decodes without setup

The engine ships these decoders, and uses them for calls and for effects:

| Chain | Decoder | Reads |
| --- | --- | --- |
| Base | `erc20` | `transfer`, `transferFrom`, `approve`, and `Transfer` and `Approval` logs |
| Base | `erc721` | NFT transfers and approvals, and their logs |
| Base | `erc1155` | single and batch transfers, and their logs |
| Base | `weth` | `deposit`, `withdraw`, and their logs |
| Base | `multicall3` | `aggregate`, `aggregate3` and `aggregate3Value`, with each inner call decoded |
| Solana | `system` | transfers, account creation, and the other System Program instructions |
| Solana | `spl-token`, `token-2022` | transfers, mints, burns, account setup and the other token instructions |
| Solana | `associated-token-account` | creating a token account |
| Solana | `memo` | the memo text |
| Solana | `compute-budget` | the compute-unit limit and price |

Anything else reads `decoded: false`, with its selector and raw data. The engine never asks a third-party service to guess what a function is.

## Register your own ABI or IDL

A call to your own contract or program shows its selector and raw data until you register it, and its logs are counted in `undecodedEvents`. Add its ABI (Base) or Anchor IDL (Solana) from the console's Contracts page or through `POST /v1/contracts`, and the call reads by function and arguments from then on, including calls already sent. [Register an ABI or IDL](./register-a-contract.md) walks through both.

## What the engine checks, and what it does not

- **The shape, at submission.** A malformed call is a `400` with `CHAIN_REJECTED` and nothing is stored, for example `call data is not a well-formed (whole-byte) hex string: hello`.
- **Not what the call does.** A call that reverts fails on the chain, and the item is `failed` with `CHAIN_REJECTED`. On Base the engine reads the revert reason. [Errors](../errors.md#what-chaindetail-holds) shows one.
- **Not what the call spends.** The [Funding Check](../lifecycle.md#the-funding-check) counts payments, not calls, not even a Base call's `value`. Make sure the Sender holds enough for your calls yourself.

Prefer a `payment` whenever you are moving money. The engine knows what a payment does, so it can check the balance first, the Signer's policy can count it against a cap, and a Multisig Sender can propose it.

## Where calls are refused

- **A Multisig Sender** proposes only native and known-token transfers. Any other call is refused at submission with `400 CHAIN_REJECTED` naming the item, such as `items[1]: …`. [Pay from a multisig](./multisig.md) explains why.
- **A Signer policy** with `allowedDestinations` refuses a call to a contract or program it does not list. It also refuses calls to a capped token other than `transfer`, such as `approve`. The item is `failed` with `SIGNER_REFUSED`.
- **A Flag Rule** of kind `call_target_not_allowlisted` holds a Dispatch whose call targets a contract or program it does not list. [Hold payments with Flag Rules](./flag-rules.md#call_target_not_allowlisted) has an example.
