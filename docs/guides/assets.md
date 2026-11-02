# Add a token with Known Assets

A `payment` item names its asset by symbol, such as `"asset": "USDC"`. The engine pays only in a Known Asset: a chain's native coin, or a token the operator listed. This guide adds two tokens, one on each chain, pays in one of them, and disables the other.

The examples ran against an engine on Base Sepolia and Solana devnet. Adding, previewing and disabling take the [operator token](../authentication.md#the-operator-token), here `$OPERATOR_TOKEN`. Listing and paying take either token.

## What a Known Asset is

Each Known Asset is one row per chain: an address, a symbol, a name and decimals. The engine reads the decimals from the chain, so you never type them in.

- **The native coins.** `ETH` on Base and `SOL` on Solana. They are always there.
- **Configured tokens.** Each entry in `BASE_KNOWN_TOKENS` or `SOLANA_KNOWN_TOKENS` becomes a row at startup. These rows read `"source": "config"`, and only the configuration changes them.
- **Tokens added through the API or the console.** These rows read `"source": "console"`. The operator adds, disables and enables them with no restart.

A symbol is unique per chain among enabled assets, ignoring case. A payment may name any enabled asset on its chain. Nothing is ever deleted, so a disabled asset still names the amounts of past payments.

## 1. See what the engine knows

```sh
curl -s "$DISPATCH_URL/v1/assets?chain=solana" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "assets": [
    {
      "id": "2b072fdc-c1e1-4dc5-86c2-68534b72dedd",
      "chain": "solana",
      "address": "native",
      "symbol": "SOL",
      "name": "Solana",
      "decimals": 9,
      "kind": "native",
      "source": "config",
      "enabled": true,
      "addedBy": null,
      "addedAt": "2026-11-01T17:24:50.604Z"
    },
    {
      "id": "1d752201-1b3a-4c8a-b46c-2cd8c832360f",
      "chain": "solana",
      "address": "3NDiyxMgwcdjmUq8ns3sxQVxudUDvwGoAW6K3VUHRx9F",
      "symbol": "F22",
      "name": "F22",
      "decimals": 6,
      "kind": "token-2022",
      "source": "config",
      "enabled": true,
      "addedBy": null,
      "addedAt": "2026-11-01T17:24:50.604Z"
    },
    {
      "id": "7807dd9b-f8eb-4521-bbf6-5d0ffdf8247b",
      "chain": "solana",
      "address": "GvZA8BJoBnFGz4Vst9e6XNac891wXEX8UxvS8PNFqKtA",
      "symbol": "FSPL",
      "name": "FSPL",
      "decimals": 6,
      "kind": "spl",
      "source": "config",
      "enabled": true,
      "addedBy": null,
      "addedAt": "2026-11-01T17:24:50.604Z"
    }
  ]
}
```

This engine has `SOL` and two test tokens from `SOLANA_KNOWN_TOKENS`. The native coin comes first, then the tokens by symbol. `kind` is `native`, `spl`, `token-2022` or `erc20`. Leave out `chain` to list every enabled chain.

## 2. Know why a payment gets `UNKNOWN_ASSET`

A payment in a symbol the chain does not know is refused before anything is stored:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: points-2026-11-01-0001" \
  -H "Content-Type: application/json" \
  -d '{"chain":"solana","items":[{"type":"payment","recipient":"Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2","asset":"PTS","amount":"25000000"}]}'
```

```json
{
  "code": "UNKNOWN_ASSET",
  "message": "no known token configured for asset \"PTS\"",
  "chainDetail": { "asset": "PTS" }
}
```

The answer is `400`. No Dispatch is stored and the `Idempotency-Key` is not used up, so you can send the same request again once the token is known. Three things cause it:

- The token is not a Known Asset on that chain. Add it, as the next steps show.
- The token was disabled. Enable it again, as [step 6](#6-disable-a-token) shows.
- The symbol is spelled differently. Compare it with `GET /v1/assets`. Symbols are matched without regard to case.

The engine records the refusal. The operator sees it on the console's **Rejected** page, whose **Add asset** link opens the Assets page with the chain and the symbol filled in. [Refused requests](../errors.md#refused-requests) has the details.

## 3. Add a token from the console

1. Sign in to the console with the operator token. The **Add asset** button shows only in an operator session.
2. Open **Assets** in the sidebar, and pick the chain's tab.
3. Click **Add asset**. A pane opens on the right.
4. Paste the token's **Mint address** (Solana) or **Contract address** (Base).
5. Leave **Symbol** empty to use the token's own symbol. Fill it in when the token publishes none, or when another asset on the chain already uses it.
6. Click **Preview**. The console reads the token from the chain and shows its name, symbol, decimals and supply, beside what the chain itself says. Nothing is stored yet.
7. Check the preview against the token you expect. Then click **Add**, labelled with the symbol, such as **Add PTS**.

The asset shows in the table at once, and the add is written to **Activity**. If the engine refuses the token, the pane says why in place, such as an address that is not a token, or a mint with a transfer fee. [Refusals when you add a token](#refusals-when-you-add-a-token) lists them.

## 4. Add a token with the API

The API does the same in two calls: a preview, which stores nothing, then the add.

### Preview it

[Preview a Known Asset](../openapi.yaml#preview-a-known-asset) reads the address from the chain and answers with what an add would store. This is USDC on Base Sepolia:

```sh
curl -s -X POST "$DISPATCH_URL/v1/assets/preview" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","address":"0x036CbD53842c5426634e7929541eC2318f3dCF7e"}'
```

```json
{
  "chain": "base",
  "kind": "erc20",
  "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "decimals": 6,
  "symbol": "USDC",
  "name": "USDC",
  "onChain": { "symbol": "USDC", "name": "USDC" },
  "supply": "89330251828252608"
}
```

`symbol` and `name` are what the engine would store. `onChain` is what the chain says. `supply` is the total supply in the smallest unit.

Some tokens publish no symbol. This devnet mint has no metadata at all, so the preview asks for one:

```sh
curl -s -X POST "$DISPATCH_URL/v1/assets/preview" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chain":"solana","address":"GyPuq9coezoKsh3enM4WgFmffcurLhA4S3uwwHn7tu4B"}'
```

```json
{
  "code": "SYMBOL_REQUIRED",
  "message": "GyPuq9coezoKsh3enM4WgFmffcurLhA4S3uwwHn7tu4B publishes no symbol on chain: give one in symbol"
}
```

### Add it

Send the same body to [Add a Known Asset](../openapi.yaml#add-a-known-asset), with `symbol` where the token needs one. `reason` is optional and goes into the activity record:

```sh title="Base"
curl -s -X POST "$DISPATCH_URL/v1/assets" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chain":"base","address":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","reason":"vendor payouts in USDC"}'
```

```sh title="Solana"
curl -s -X POST "$DISPATCH_URL/v1/assets" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chain":"solana","address":"GyPuq9coezoKsh3enM4WgFmffcurLhA4S3uwwHn7tu4B","symbol":"PTS","reason":"loyalty points payouts"}'
```

```json title="Base"
{
  "id": "d3046d79-5f8e-4a6d-9a31-cb49d6f65e93",
  "chain": "base",
  "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "symbol": "USDC",
  "name": "USDC",
  "decimals": 6,
  "kind": "erc20",
  "source": "console",
  "enabled": true,
  "addedBy": "operator",
  "addedAt": "2026-11-01T17:30:54.937Z"
}
```

```json title="Solana"
{
  "id": "7c0293e0-c48e-4f48-8ddc-68527f61a61e",
  "chain": "solana",
  "address": "GyPuq9coezoKsh3enM4WgFmffcurLhA4S3uwwHn7tu4B",
  "symbol": "PTS",
  "name": "PTS",
  "decimals": 6,
  "kind": "spl",
  "source": "console",
  "enabled": true,
  "addedBy": "operator",
  "addedAt": "2026-11-01T17:30:55.633Z"
}
```

`201` means the asset is enabled. The API and the worker see it on their next request, with no restart. A token that publishes no name takes its symbol as its name.

## 5. Pay in it

The request that failed in step 2 now goes through. Use a new `Idempotency-Key` only if you changed the request:

```sh
curl -s -X POST "$DISPATCH_URL/v1/dispatch" \
  -H "Authorization: Bearer $DISPATCH_TOKEN" \
  -H "Idempotency-Key: points-2026-11-01-0001" \
  -H "Content-Type: application/json" \
  -d '{"chain":"solana","items":[{"type":"payment","recipient":"Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2","asset":"PTS","amount":"25000000"}]}'
```

```json
{ "dispatchId": "8142d0dd-6d8a-4828-b908-ae3b0cecf9ee", "status": "queued" }
```

`amount` is in the token's smallest unit. PTS has 6 decimals, so `25000000` is 25 PTS. Read it back with [Get a Dispatch](../openapi.yaml#get-a-dispatch). The item carries the asset's `decimals`:

```sh
curl -s "$DISPATCH_URL/v1/dispatch/$DISPATCH_ID" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatchId": "8142d0dd-6d8a-4828-b908-ae3b0cecf9ee",
  "mode": "managed",
  "chain": "solana",
  "sender": { "name": "payouts", "address": "7oCe2HetopE1x3eepG7suVMWh8a8CKUYShTnY8b96a82" },
  "createdAt": "2026-11-01T17:30:55.690Z",
  "status": "queued",
  "items": [
    {
      "type": "payment",
      "recipient": "Dmp2B7tvZKohJCYoD7YRk4aTo5k1Ndz2Wh7pGYsSCaT2",
      "asset": "PTS",
      "decimals": 6,
      "amount": "25000000",
      "status": "queued",
      "transactionHash": null,
      "error": null
    }
  ]
}
```

The Sender must hold the token. The [Funding Check](../lifecycle.md#the-funding-check) fails a payment it cannot cover with `INSUFFICIENT_FUNDS`, before anything is signed. On Solana the engine creates the recipient's token account when it has none, and the Sender pays that rent in SOL.

## 6. Disable a token

[Enable or disable a Known Asset](../openapi.yaml#enable-or-disable-a-known-asset) stops new payments naming it. Use the `id` from the add or the list:

```sh
curl -s -X PATCH "$DISPATCH_URL/v1/assets/d3046d79-5f8e-4a6d-9a31-cb49d6f65e93" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false,"reason":"USDC payouts paused while the treasury rebalances"}'
```

```json
{
  "id": "d3046d79-5f8e-4a6d-9a31-cb49d6f65e93",
  "chain": "base",
  "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "symbol": "USDC",
  "name": "USDC",
  "decimals": 6,
  "kind": "erc20",
  "source": "console",
  "enabled": false,
  "addedBy": "operator",
  "addedAt": "2026-11-01T17:30:54.937Z"
}
```

From now on a payment in `USDC` on Base gets `400 UNKNOWN_ASSET`. A payment the engine already accepted still goes out. Send `{"enabled":true}` to enable it again. Enabling is refused with `409 SYMBOL_TAKEN` while another enabled asset on the chain has the symbol.

In the console, a token added there has a switch in its row. Each change asks for confirmation and takes an optional reason.

## 7. Configure tokens instead

Tokens you always pay in can live in the configuration. Each entry is `SYMBOL:address:decimals`, comma separated, and a Token-2022 mint adds `:token-2022`:

```sh
BASE_KNOWN_TOKENS=USDC:0x036CbD53842c5426634e7929541eC2318f3dCF7e:6
SOLANA_KNOWN_TOKENS=USDC:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU:6
```

Restart the API and the worker after a change. The engine checks each configured Solana mint against the chain at startup. An entry you remove later is disabled, never deleted. A config row cannot be disabled through the API or the console. `PATCH` on one answers `409`:

```json
{
  "code": "CONFIG_ASSET",
  "message": "this asset comes from the configuration (SOLANA_KNOWN_TOKENS, BASE_KNOWN_TOKENS or the native coin): change it there and restart"
}
```

Remove the entry and restart instead. [Configuration](../self-hosting/configuration.md) lists both variables.

Choose the configuration for the tokens your deployment cannot run without, so a fresh database starts with them. Choose the API or the console for tokens you add as you go.

## Refusals when you add a token

The preview and the add refuse the same things, with the same codes:

| `code` | Status | Cause | What to do |
| --- | --- | --- | --- |
| `NOT_A_TOKEN` | `400` | On Base, no contract at the address, or one that does not answer `decimals()` and `totalSupply()`. On Solana, an account that is not a mint. | Check the address and the chain. |
| `NOT_PAYABLE` | `400` | A Solana mint the engine cannot pay out correctly: a transfer fee, a transfer hook, non-transferable, or new accounts frozen by default. | Pay in another token. |
| `SYMBOL_REQUIRED` | `400` | The token publishes no usable symbol. | Send `symbol`. |
| `SYMBOL_TAKEN` | `409` | Another enabled asset on the chain has the symbol, ignoring case. | Send another `symbol`, or disable the other asset first. |
| `ASSET_EXISTS` | `409` | The address is already a Known Asset on the chain, enabled or not. | Enable it with `PATCH /v1/assets/{id}`. |
| `RPC_UNAVAILABLE` | `503` | The engine could not read the chain. | Try again. |

Every add, disable and enable is an operator action. Read them with [List operator actions](../openapi.yaml#list-operator-actions) or on the console's **Activity** page.
