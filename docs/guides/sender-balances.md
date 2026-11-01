# Read Sender balances before you send

The engine checks the Sender's balance only after it claims a Dispatch, and fails what it cannot cover with `INSUFFICIENT_FUNDS`. This guide checks first, with [List Senders](../openapi.yaml#list-senders), so you can top up the Sender before you submit a run.

## 1. List the Senders

```sh
curl -s "$DISPATCH_URL/v1/senders" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "senders": [
    {
      "chain": "base",
      "network": "base-sepolia",
      "mode": "single",
      "address": "0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A",
      "multisig": null,
      "balances": [
        {
          "holder": "sender",
          "address": "0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A",
          "assets": [
            { "asset": "ETH", "decimals": 18, "balance": "5692964363506001", "committed": "0" },
            { "asset": "USDC", "decimals": 6, "balance": "0", "committed": "0" }
          ]
        }
      ],
      "signerKey": {
        "curve": "secp256k1",
        "address": "0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A",
        "readAt": "2026-11-01T02:09:20.649Z"
      }
    },
    {
      "chain": "solana",
      "network": "devnet",
      "mode": "single",
      "address": "33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf",
      "multisig": null,
      "balances": [
        {
          "holder": "sender",
          "address": "33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf",
          "assets": [
            { "asset": "SOL", "decimals": 9, "balance": "9175636623", "committed": "0" },
            { "asset": "USDC", "decimals": 6, "balance": "0", "committed": "0" }
          ]
        }
      ],
      "signerKey": {
        "curve": "ed25519",
        "address": "33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf",
        "readAt": "2026-11-01T02:09:20.669Z"
      }
    }
  ]
}
```

There is one entry per enabled chain. `network` is the network the engine talks to, so you can link to the right explorer: `base`, `base-sepolia`, `mainnet-beta`, `devnet`, `testnet`, `unknown`, or `{ "chainId": n }` for another Base chain ID.

## 2. Work out what is free

Each entry in `balances` is one balance the Funding Check looks at. `holder` names it with the same word `INSUFFICIENT_FUNDS` uses in `chainDetail.holder`:

| `mode` | Holders |
| --- | --- |
| `single` | `sender`, which pays everything. |
| `squads` | `vault`, which pays the payments, and `memberKey`, the engine's own key, which pays fees and Proposal rent. |
| `safe` | `safe`, which pays the payments, and `executor`, the engine's own key, which pays gas. |

Each balance lists the native asset and every known token, in the smallest unit, with `decimals`. The engine's own key lists only its native asset. `committed` is what open Proposals and Calls waiting to be proposed already hold back. It is always `"0"` for a plain Sender. What a new Dispatch can spend is `balance` minus `committed`.

## 3. Compare it with your run

Add up your run per asset, in the smallest unit, and compare. Use whole-number arithmetic, never floats: an 18-decimal ETH amount does not fit in a double.

```js title="JavaScript"
async function shortfalls(chain, run) {
  const response = await fetch(`${process.env.DISPATCH_URL}/v1/senders`, {
    headers: { Authorization: `Bearer ${process.env.DISPATCH_TOKEN}` },
  });
  const { senders } = await response.json();
  const payer = senders.find((s) => s.chain === chain).balances[0];
  const needs = {};
  for (const { asset, amount } of run) needs[asset] = (needs[asset] ?? 0n) + BigInt(amount);
  return Object.entries(needs).flatMap(([asset, need]) => {
    const held = payer.assets.find((a) => a.asset === asset);
    if (!held || typeof held.balance !== 'string') return [{ asset, need, free: null }];
    const free = BigInt(held.balance) - BigInt(held.committed);
    return free >= need ? [] : [{ asset, need, free }];
  });
}

console.log(
  await shortfalls('base', [
    { asset: 'ETH', amount: '50000000000000' },
    { asset: 'USDC', amount: '40000000' },
  ]),
);
```

```python title="Python"
import os
from collections import defaultdict

import requests


def shortfalls(chain, run):
    senders = requests.get(
        f"{os.environ['DISPATCH_URL']}/v1/senders",
        headers={"Authorization": f"Bearer {os.environ['DISPATCH_TOKEN']}"},
    ).json()["senders"]
    payer = next(s for s in senders if s["chain"] == chain)["balances"][0]
    needs = defaultdict(int)
    for item in run:
        needs[item["asset"]] += int(item["amount"])
    short = []
    for asset, need in needs.items():
        held = next((a for a in payer["assets"] if a["asset"] == asset), None)
        if held is None or not isinstance(held["balance"], str):
            short.append({"asset": asset, "need": need, "free": None})
        elif int(held["balance"]) - int(held["committed"]) < need:
            short.append({"asset": asset, "need": need, "free": int(held["balance"]) - int(held["committed"])})
    return short


print(shortfalls("base", [{"asset": "ETH", "amount": "50000000000000"}, {"asset": "USDC", "amount": "40000000"}]))
```

For the Sender above, both print one shortfall: USDC, which needs 40000000 and has 0 free. `free: null` means the engine could not read that balance.

The engine counts more than the payments, so leave a margin:

- **On Solana** it also counts the SOL for each transaction's fee, any priority fee, and the rent of every recipient token account it has to create.
- **On Base** each transaction's gas comes out of the Sender's ETH.
- **For a Multisig Sender** the engine's own key, `memberKey` or `executor`, pays the fees and any Proposal rent, so check that balance too.

## 4. Check the Signer's key

`signerKey` is what the Signer reported about the key the engine signs with: its `address`, its `curve`, and each pin its policy sets (`chainIds`, `allowedSafe`, `allowedMultisig`). The API never calls the Signer. The worker reads this when it starts and every five minutes after, and `readAt` says when it last did, so it can be up to five minutes behind a change to the Signer's policy.

- Before the worker's first read, `signerKey` is `{ "status": "not_read_yet" }`.
- A failed read is `{ "error": "...", "readAt": "..." }`. The error says the Signer has no key for this address, is too old to report a policy, or could not be reached.

For a Multisig Sender, the key should be pinned to the multisig: `allowedMultisig` on Solana, or `allowedSafe` with the chain ID in `chainIds` on Base. The worker refuses to start otherwise.

## When a read fails

A read that fails changes only its own field to `{ "error": "<reason>" }`, and the route still answers `200`. A balance or a multisig `threshold` carries an error code, such as `{ "error": "RPC_UNAVAILABLE" }`. The details go to the engine's log, never into the response, and no secret, key reference or token ever does.

The API reads the chain itself and keeps the answer for 15 seconds, so polling this route costs at most one round of RPC reads per 15 seconds. A balance you read can be up to 15 seconds old.
