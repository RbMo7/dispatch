# Register an ABI or IDL

The engine sends a `call` item without interpreting it. Once the call has gone out, the console and the API explain it: which function ran, with which arguments, and what it changed on chain. Standard contracts and programs need nothing from you. For your own, register the contract's ABI (Base) or the program's Anchor IDL (Solana).

A registration takes effect at once, and for calls already sent too. The engine decodes calls and their effects each time a Dispatch is read, never when it is sent, so registering an ABI today explains last week's calls.

## What is explained without registering

| Chain | Built-in decoders |
| --- | --- |
| `base` | ERC-20, ERC-721, ERC-1155, WETH, Multicall3 |
| `solana` | System, SPL Token, Token-2022, Associated Token Account, Memo, Compute Budget |

The built-ins are tried first. A registration explains what they do not, and gives the contract a label either way.

An unexplained call shows its 4-byte selector (Base) or its instruction discriminator (Solana) and the raw data. The engine never asks a third-party service to guess a signature.

## From the console

1. Open the Dispatch and its Items or Details tab. A call no decoder knows reads "Selector 0xa26e1186, no ABI", and its transaction's effects read "1 event with no ABI".
2. Choose **Add ABI** (or **Add IDL** on Solana). It needs an operator session. It opens the Contracts page with the chain and address filled in.
3. Give the contract a label, paste the ABI or IDL, and choose **Preview**. The preview lists the functions and events it explains, or says what is wrong with what you pasted.
4. Choose **Add ABI**. Go back to the Dispatch: the call now reads `deposit(note: "invoice 2041")` under the label, and its event is named.

The Contracts page lists every registration per chain. Disable one to stop it explaining calls. To correct an ABI, disable the old registration and add the new one: an address has at most one enabled registration.

## With the API

Registering takes the operator token. Paste the ABI as `abi`: the JSON array, a compiler artifact that holds one in `abi` (as Foundry and Hardhat write them), or the same as text.

```sh
curl -X POST http://localhost:8420/v1/contracts \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "chain": "base",
    "address": "0x79bB95AEF7f032144A9A5C6933B8d13a98e6D793",
    "label": "FlowVault",
    "reason": "Explain vault deposits",
    "abi": [
      { "type": "event", "name": "Deposited", "inputs": [
        { "name": "from", "type": "address", "indexed": true },
        { "name": "amount", "type": "uint256" },
        { "name": "note", "type": "string" } ] },
      { "type": "function", "name": "deposit", "stateMutability": "payable",
        "inputs": [{ "name": "note", "type": "string" }], "outputs": [] }
    ]
  }'
```

The answer lists what it explains:

```json
{
  "label": "FlowVault",
  "functions": ["deposit(string note)"],
  "events": ["Deposited(address indexed from, uint256 amount, string note)"],
  "enabled": true
}
```

On Solana, send `idl` instead: the IDL file Anchor writes, in the 0.30 format or the older one. If the IDL names its program in `address`, it must be the address you register.

`POST /v1/contracts/preview` takes the same body and answers with the same lists, storing nothing. `GET /v1/contracts` lists registrations with either token. `PATCH /v1/contracts/{id}` with `{ "enabled": false }` disables one. Each registration and change is written to the activity record.

## What a decoded call looks like

Each `call` item of `GET /v1/dispatch/{id}` carries a `call` block. After registering FlowVault:

```json
{
  "target": "0x79bB95AEF7f032144A9A5C6933B8d13a98e6D793",
  "label": "FlowVault",
  "decoded": true,
  "decoder": "abi",
  "function": "deposit",
  "args": [{ "name": "note", "type": "string", "value": "invoice 2041" }],
  "selector": "0xa26e1186",
  "value": { "amount": "1000000000000", "asset": { "symbol": "ETH", "name": "Ether", "decimals": 18, "address": "native" }, "formatted": "0.000001" }
}
```

Once the transaction confirms and the worker has read it, the item's `effects` list the transfers, the fee and the decoded events, with `undecodedEvents` counting what no decoder or registration explains.

An ABI or IDL says nothing about units, so a registered call's arguments are plain numbers, with two exceptions. An unsigned argument named like an amount (`amount`, `value`, `wad`, or ending in `Amount`) is shown in a Known Asset's units when the call is to that token, or names exactly one Known Asset among its addresses or accounts. On Solana, an argument ending in `lamports` is shown in SOL.

## Refusals

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_ABI` | 400 | The ABI is not JSON, or an item or parameter is malformed. The message names it, as in `abi[0].inputs[0].type: "strng" is not a Solidity type`. |
| `INVALID_IDL` | 400 | The IDL is not JSON, uses a type it never defines, uses generics, or names another program. |
| `CONTRACT_EXISTS` | 409 | An enabled registration already has this address. Disable it first. |

Anchor events that a program writes to its logs are not decoded. Its instructions are, inner ones included.
