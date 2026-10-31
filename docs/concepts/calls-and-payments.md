# Calls and Payments

A Managed Dispatch's `items` mix two types freely. A **Call** is what a chain actually executes: a destination and data you encoded. A **Payment** is a shortcut for the most common Call, a transfer, written as recipient, asset and amount. Every Payment becomes a Call before it reaches the chain. Not every Call is a Payment ([ADR-0018](../adr/0018-call-not-payment-is-the-primitive.md)).

## Payment: say what to pay

```json
{ "type": "payment", "recipient": "0x8ba1f109551bD432803012645Ac136ddd64DBA72", "asset": "USDC", "amount": "12500000" }
```

The engine turns this into the right Call for the chain and asset:

- The native asset (`ETH` on Base, `SOL` on Solana) becomes a plain transfer.
- A token becomes the token's transfer: an ERC-20 `transfer` on Base, an SPL or Token-2022 `transferChecked` on Solana. On Solana the engine also creates the recipient's token account if it does not exist yet, and counts its rent in the [Funding Check](./funding-check.md).

`asset` is a symbol the operator configured. A token has to be listed in `BASE_KNOWN_TOKENS` or `SOLANA_KNOWN_TOKENS` with its contract or mint and its decimals. Otherwise the item is refused with `UNKNOWN_ASSET` ([ADR-0029](../adr/0029-unknown-asset-error-code.md)).

`amount` is a whole number in the asset's smallest unit, as a string: `12500000` is 12.5 USDC (6 decimals). When you read a Dispatch back, each payment item carries `decimals`, so you can format it without a token table of your own.

Prefer a Payment whenever you are moving money. The engine knows what it does, so it can check the balance first, the Signer's policy can count it against a cap, and a Multisig Sender can propose it.

## Call: send what you encoded

A Call carries exactly what the chain needs, and the engine sends it without interpreting it. You own the ABI or the IDL.

```json title="Base"
{ "type": "call", "to": "0x8ba1f109551bD432803012645Ac136ddd64DBA72", "data": "0x", "value": "20000000000000" }
```

```json title="Solana"
{
  "type": "call",
  "programId": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "accounts": [],
  "data": "aW52b2ljZSA0NDcx"
}
```

On Base a Call is `{ to, data, value }`: the contract or address, the calldata as `0x` hex, and the wei to send with it. On Solana it is `{ programId, accounts, data }`: the program, its accounts as `{ pubkey, isSigner, isWritable }`, and the instruction data in base64. The Solana example above writes the memo `invoice 4471` with the Memo program.

The API checks a Call's shape when you submit it, so malformed calldata is a `400` and never queued. It cannot check what the Call does. A Call that reverts fails on the chain, as `CHAIN_REJECTED`.

The engine signs only with the Sender's key. A Solana Call that needs any other account to sign cannot be completed by the engine.

## Mixing them

One Dispatch can hold both. This real Dispatch on devnet writes a memo and pays 0.0025 SOL, and on Solana both went out in one transaction:

```json
{
  "chain": "solana",
  "items": [
    { "type": "call", "programId": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "accounts": [], "data": "aW52b2ljZSA0NDcx" },
    { "type": "payment", "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2", "asset": "SOL", "amount": "2500000" }
  ]
}
```

When you read a Call item back, it shows its `type` and its target (`to` or `programId`), not its data, value or accounts.

## Where Calls are refused

- A **Multisig Sender** proposes only native and known-token transfers. Any other Call is refused at submission with a `400` naming the item ([Multisig Sender](./multisig-and-treasury.md)).
- A **Signer policy** with `allowedDestinations` refuses a Call to a contract or program it does not list, and a capped token's Calls other than `transfer`, such as `approve`.
