# Send from more than one Sender

An engine can hold several named Senders on one chain, each with its own key, signing mode, balances and nonce. Each request names the Sender that pays. This guide sets up the common pair on Solana: `payouts`, a hot wallet that pays routine payouts straight away, and `treasury`, a Squads multisig whose Approvers vote on every transfer. Base works the same way, with a Safe as the multisig.

A Sender that is stuck, short of funds, or waiting for approval never delays another Sender's Dispatches. The engine claims, funds, signs and bundles each Sender's Dispatches on their own, and a bundle or a Proposal never mixes Senders.

## One engine per Sender

A Sender belongs to one engine. The engine's worker tracks the Sender's nonce and its pending transactions, so a second engine, a wallet app or a script that sends from the same key breaks that tracking. On Base the two collide on nonces, and items fail with `NONCE_ALREADY_USED`. Named Senders are how you split work: one engine, several Senders, each with its own key and balance. Run a second engine only for a separate set of keys, such as one engine for testnet and one for mainnet.

## 1. Write the senders file

Name the Senders in a JSON file, keyed by chain. The engine reads `senders.json` from the folder it starts in, or the file `SENDERS_FILE` names:

```json
{
  "solana": {
    "default": "payouts",
    "senders": {
      "payouts": { "address": "33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf" },
      "treasury": {
        "mode": "squads",
        "multisig": "4AzEDD9wGkvTs4hpRNGZ44tgt2xCZbwoFWNKZs28UkuC",
        "memberKey": "8DyMoRsmCavhT6Ev8kxsX7YjzJaD6hUdjxirr1yqDgwV"
      }
    }
  }
}
```

- `payouts` is a plain Sender. The Signer holds the key for its `address`.
- `treasury` pays from the multisig's vault. `memberKey` is the engine's own key, which proposes and executes but never votes. [Set up a multisig Sender](../self-hosting/multisig.md#squads-on-solana) creates the multisig, the key and the Signer's pin.
- `default` is the Sender that pays when a request names none. Leave it out to make every request name its Sender.

Names are 1 to 40 lowercase letters, digits or hyphens, unique per chain. Every enabled chain needs at least one Sender, and no two Senders on a chain may share an address or an engine key. [Configuration](../self-hosting/configuration.md#the-senders-file) lists every field.

With a senders file, the engine ignores the per-chain Sender variables, such as `SOLANA_SENDER_ADDRESS` and `SOLANA_SENDER_MODE`, and logs a warning if any is set. Restart the API and the worker. Both read the file at startup, and both refuse to start on a file with a problem, naming every problem at once. The worker logs the Senders it serves:

```json
{ "chains": ["solana"], "senders": ["solana:payouts (default)", "solana:treasury"], "msg": "worker started" }
```

To try the setup before the multisig exists, give `treasury` a plain `address` for now. The examples below ran that way on devnet. Your requests do not change when `treasury` becomes a multisig. Only what happens after `202` changes: the treasury's Dispatches wait for approval, as [Pay from a multisig](./multisig.md) describes.

## 2. Check what the engine loaded

[List Senders](../openapi.yaml#list-senders) returns one entry per Sender, in the order the file lists them:

```sh
curl -s "$DISPATCH_URL/v1/senders" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

Each entry starts with its chain, its name, whether it is the chain's default, its network, its mode and its address:

```jsonc
[
  { "chain": "solana", "name": "payouts", "default": true, "network": "devnet", "mode": "single", "address": "33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf" },
  { "chain": "solana", "name": "treasury", "default": false, "network": "devnet", "mode": "single", "address": "CPV2hjMmyjg9NvVC9tSGuNfG2AUzSK76ieC5rZ5dk2oW" }
]
```

For a Squads treasury, `mode` reads `squads`, `address` is the vault, and `multisig` names the multisig and its threshold. Each entry also has the Sender's balances and its Signer key. Fund each Sender on its own, because a Sender pays only from its own balance.

## 3. Pay a payout from the default Sender

A request without `sender` pays from the chain's default, here `payouts`:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: payouts-2026-11-01-0042" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "solana",
    "items": [
      { "type": "payment", "recipient": "7wtP4Zab5pdUBgs6G4p37YQz6v8gaWWR684nqbtVjnJr", "asset": "SOL", "amount": "2500000" }
    ]
  }'
```

```json
{ "dispatchId": "dac8a1eb-bb13-4db1-af4c-108d59ce6d0c", "status": "queued" }
```

Code written before the engine had a second Sender keeps working unchanged, as long as the chain has a default.

## 4. Pay a vendor from the treasury

Name the Sender with `sender`:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: vendor-invoice-8812" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "solana",
    "sender": "treasury",
    "items": [
      { "type": "payment", "recipient": "4sjqyqVfAFBFRUk3AVDD9AiBbjakAjQ6rixqmwhKo3Wi", "asset": "SOL", "amount": "20000000" }
    ]
  }'
```

```json
{ "dispatchId": "ea2d0802-a93a-4dc1-8a4e-e80c5e5d5ecc", "status": "queued" }
```

`sender` takes a Sender's name, never its address. The Idempotency-Key rules do not change. A repeated key returns the stored Dispatch, even when the repeated request names a different Sender. A multisig treasury proposes only transfers, so send a `call` item from `payouts` instead.

## 5. Read the Sender back

[Get a Dispatch](../openapi.yaml#get-a-dispatch) names the Sender that pays, by name and address:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/ea2d0802-a93a-4dc1-8a4e-e80c5e5d5ecc" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "ea2d0802-a93a-4dc1-8a4e-e80c5e5d5ecc",
  "mode": "managed",
  "chain": "solana",
  "sender": { "name": "treasury", "address": "CPV2hjMmyjg9NvVC9tSGuNfG2AUzSK76ieC5rZ5dk2oW" },
  "createdAt": "2026-11-01T12:50:46.202Z",
  "status": "confirmed",
  "items": [
    {
      "type": "payment",
      "recipient": "4sjqyqVfAFBFRUk3AVDD9AiBbjakAjQ6rixqmwhKo3Wi",
      "asset": "SOL",
      "decimals": 9,
      "amount": "20000000",
      "status": "confirmed",
      "transactionHash": "9cBHgm99kT2ddusmS1yYDCBGgwuExCebv5o4FpMPh732joozquHkyLX35zjKHndhYQ9LJgoFGPLSTZmd3KHCRvo",
      "error": null
    }
  ]
}
```

The payout from step 3 reads `"sender": { "name": "payouts", "address": "33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf" }`, though its request named none.

The address is the Sender's identity, and the engine records it when it accepts the Dispatch. If the operator renames a Sender in the file, its Dispatches show the new name. If the operator removes a Sender, its Dispatches keep their `address` and read `"name": null`, and the engine still tracks their unfinished work to the end. A Relay Dispatch has no `sender`, because it arrives already signed.

## 6. List one Sender's Dispatches

[List Dispatches](../openapi.yaml#list-dispatches) takes a `sender` filter:

```sh
curl -s "$DISPATCH_URL/v1/dispatches?chain=solana&sender=treasury" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatches": [
    {
      "dispatchId": "ea2d0802-a93a-4dc1-8a4e-e80c5e5d5ecc",
      "mode": "managed",
      "chain": "solana",
      "sender": { "name": "treasury", "address": "CPV2hjMmyjg9NvVC9tSGuNfG2AUzSK76ieC5rZ5dk2oW" },
      "status": "confirmed",
      "createdAt": "2026-11-01T12:50:46.202Z",
      "itemCount": 1,
      "totals": [{ "asset": "SOL", "amount": "20000000", "decimals": 9 }]
    }
  ],
  "nextCursor": null
}
```

Names are unique per chain, not across chains. Without `chain`, the filter matches every chain's Sender of that name.

## 7. Filter by Sender in the console

On a chain with more than one Sender, the console's **Dispatches** page shows a **Sender** filter beside the chain filter, and each row names its Sender. A Dispatch's **Details** tab shows the Sender's name and address. **Senders & Keys** shows one card per Sender, grouped by chain, with the default marked. [The web console](../self-hosting/console.md#the-pages) describes each page.

## When a request names the wrong Sender

Both mistakes answer `400` and store nothing, so the Idempotency-Key is not used up.

`UNKNOWN_SENDER` means the chain has no Sender of that name. The message lists the names it has:

```json
{ "code": "UNKNOWN_SENDER", "message": "solana has no Sender named \"payroll\" (payouts, treasury)" }
```

The `sender` filter on List Dispatches answers the same code for a name no chain has.

`SENDER_REQUIRED` means the request names no Sender, and the senders file names no `default` for the chain. Name the Sender with `sender`, or ask the operator to set a default:

```json
{ "code": "SENDER_REQUIRED", "message": "solana has no default Sender: name one with \"sender\" (payouts, treasury)" }
```

A Relay Dispatch that names a `sender` is a `400` too, because the engine holds no key for it.

## Next steps

- [Hold payments with Flag Rules](./flag-rules.md), scoped to one Sender with `sender`, to have a person look at large payouts before the hot Sender pays them.
- [Read Sender balances before you send](./sender-balances.md), for each Sender.
- [Pay from a multisig](./multisig.md), for what the treasury's Dispatches do while they wait for approval.
