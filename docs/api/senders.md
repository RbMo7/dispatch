# Senders

## `GET /v1/senders`

Returns one entry per enabled chain: who pays, what it holds, and what the Signer says about the engine's key. Needs the `Authorization` header.

The API process reads the chain and the Signer itself, so a browser never talks to either, and keeps the answer for 15 seconds. A console polling it costs at most one round of RPC and Signer reads per 15 seconds.

```sh
curl -s "$DISPATCH_URL/v1/senders" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

Two plain Senders, one per chain, each with a known USDC token configured:

```json
{
  "senders": [
    {
      "chain": "base",
      "mode": "single",
      "address": "0x1Dd9661FAb2d82731E033c21C46BA009633bf558",
      "multisig": null,
      "balances": [
        {
          "holder": "sender",
          "address": "0x1Dd9661FAb2d82731E033c21C46BA009633bf558",
          "assets": [
            { "asset": "ETH", "decimals": 18, "balance": "2000000000000000", "committed": "0" },
            { "asset": "USDC", "decimals": 6, "balance": "0", "committed": "0" }
          ]
        }
      ],
      "signerKey": { "address": "0x1Dd9661FAb2d82731E033c21C46BA009633bf558", "curve": "secp256k1" }
    },
    {
      "chain": "solana",
      "mode": "single",
      "address": "6vojQiQfhxJuiW5LDG2U8NvmG6G97MKXqvkQkJhYHKm2",
      "multisig": null,
      "balances": [
        {
          "holder": "sender",
          "address": "6vojQiQfhxJuiW5LDG2U8NvmG6G97MKXqvkQkJhYHKm2",
          "assets": [
            { "asset": "SOL", "decimals": 9, "balance": "200000000", "committed": "0" },
            { "asset": "USDC", "decimals": 6, "balance": "0", "committed": "0" }
          ]
        }
      ],
      "signerKey": { "address": "6vojQiQfhxJuiW5LDG2U8NvmG6G97MKXqvkQkJhYHKm2", "curve": "ed25519" }
    }
  ]
}
```

A Squads Multisig Sender, with one balance read that failed. This one is an illustration, not a live run:

```json
{
  "senders": [
    {
      "chain": "solana",
      "mode": "squads",
      "address": "<vault>",
      "multisig": { "address": "<multisig>", "threshold": 2, "engineKey": "<member key>" },
      "balances": [
        {
          "holder": "vault",
          "address": "<vault>",
          "assets": [
            { "asset": "SOL", "decimals": 9, "balance": "9000000", "committed": "0" },
            { "asset": "USDC", "decimals": 6, "balance": { "error": "RPC_UNAVAILABLE" }, "committed": "120" }
          ]
        },
        {
          "holder": "memberKey",
          "address": "<member key>",
          "assets": [{ "asset": "SOL", "decimals": 9, "balance": "3000000", "committed": "2039280" }]
        }
      ],
      "signerKey": { "address": "<member key>", "curve": "ed25519", "allowedMultisig": "<multisig>" }
    }
  ]
}
```

## Fields

| Field | Means |
| --- | --- |
| `chain` | `base` or `solana` |
| `mode` | `single`, `squads` or `safe` |
| `address` | The Sender: the plain key, the Squads vault, or the Safe |
| `multisig` | `null` for `single`. Otherwise the Squads multisig account or the Safe as `address`, its approval `threshold` as the chain reports it, and `engineKey`, the engine's own key (the Squads member key or the Safe executor). |
| `balances` | The balances the [Funding Check](../concepts/funding-check.md) looks at ([ADR-0043](../adr/0043-the-funding-check-counts-what-sending-costs.md), [ADR-0054](../adr/0054-multisig-approval-is-a-chain-handler-capability-and-a-proposal-never-mixes-dispatches.md)) |
| `signerKey` | What the Signer reports about the key the engine signs with |

### `balances`

Each entry has a `holder`, using the same names `INSUFFICIENT_FUNDS` reports in `chainDetail.holder`: `sender` for a plain Sender, `vault` and `memberKey` on Squads, and `safe` and `executor` on Safe.

Each lists the native asset and every known token, in the smallest unit. The engine's own key lists only its native asset, which pays the network cost. `decimals` is the asset's, as on a `payment` item.

`committed` is what open Proposals and Calls waiting to be proposed already hold back from that balance: the amount the Funding Check subtracts. It is always `"0"` for a plain Sender.

### `signerKey`

`signerKey` is what the Signer answers on `GET /keys/{address}/policy` ([ADR-0055](../adr/0055-the-signer-reports-its-pins-and-the-engine-checks-them-at-startup.md)) for the key the engine signs with: the Sender for `single`, `engineKey` otherwise. It has `address`, `curve`, and each pin that is set: `chainIds`, `allowedSafe`, `allowedMultisig`. It never names the key's backend.

### When a read fails

A read that fails degrades only its own field to `{ "error": "<reason>" }`, and the rest still returns, with `200`. A balance or `threshold` error is the error code, such as `RPC_UNAVAILABLE`. A `signerKey` error says whether the Signer has no key for the address, is too old to report a policy, or could not be reached. The details go to the engine's log, never into the response, and no secret, key reference or token ever does.

With the Signer stopped, a real answer still lists the balances and degrades only the key:

```json
"signerKey": { "error": "the Signer could not be reached" }
```
