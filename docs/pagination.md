# Pagination

[List Dispatches](./openapi.yaml#list-dispatches) returns Managed and Relay Dispatches together, newest first, a page at a time. You page with a cursor, not a page number.

## Read the first page

`limit` sets the rows per page, from 1 to 100. It defaults to 25.

```sh
curl -s "$DISPATCH_URL/v1/dispatches?limit=2" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatches": [
    {
      "dispatchId": "ec4a9228-b427-4f4e-9792-44ab1b8fcbd6",
      "mode": "managed",
      "chain": "solana",
      "status": "confirmed",
      "createdAt": "2026-11-01T02:13:35.704Z",
      "itemCount": 2,
      "totals": [{ "asset": "SOL", "amount": "4650000", "decimals": 9 }]
    },
    {
      "dispatchId": "ecf5aff7-d3ce-4c72-92ed-06f910c7b5f2",
      "mode": "managed",
      "chain": "base",
      "status": "cancelled",
      "createdAt": "2026-11-01T02:13:21.921Z",
      "itemCount": 1,
      "totals": [{ "asset": "USDC", "amount": "12500000", "decimals": 6 }]
    }
  ],
  "nextCursor": "WyIyMDI2LTExLTAxVDAyOjEzOjIxLjkyMTI3NloiLCJlY2Y1YWZmNy1kM2NlLTRjNzItOTJlZC0wNmY5MTBjN2I1ZjIiXQ"
}
```

Each row is the Dispatch without its items, plus `itemCount` and `totals`: the sum per asset of the payment items, in the asset's smallest unit, with the asset's `decimals`. Call items carry no amount, and a Relay Dispatch has none, so its `totals` is empty. A Relay row also has `transactionHash` and `error`.

## Follow `nextCursor`

Pass `nextCursor` back as `cursor`, exactly as it came, to get the next page. Keep the same filters and `limit`. Stop when `nextCursor` is `null`: it is `null` on the last page, and only there.

```sh
curl -s "$DISPATCH_URL/v1/dispatches?limit=2&cursor=WyIyMDI2LTExLTAxVDAyOjEzOjIxLjkyMTI3NloiLCJlY2Y1YWZmNy1kM2NlLTRjNzItOTJlZC0wNmY5MTBjN2I1ZjIiXQ" \
  -H "Authorization: Bearer $DISPATCH_TOKEN"
```

The cursor is opaque. Do not build or edit one: a cursor the API did not issue is a `400` with `cursor is not one this API issued`.

This loop reads every confirmed Dispatch on Base:

```js title="JavaScript"
const rows = [];
let cursor = null;
do {
  const query = new URLSearchParams({ chain: 'base', status: 'confirmed', limit: '100' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`${process.env.DISPATCH_URL}/v1/dispatches?${query}`, {
    headers: { Authorization: `Bearer ${process.env.DISPATCH_TOKEN}` },
  });
  const page = await response.json();
  rows.push(...page.dispatches);
  cursor = page.nextCursor;
} while (cursor !== null);
console.log(rows.length);
```

```python title="Python"
import os

import requests

rows, cursor = [], None
while True:
    params = {"chain": "base", "status": "confirmed", "limit": 100}
    if cursor:
        params["cursor"] = cursor
    page = requests.get(
        f"{os.environ['DISPATCH_URL']}/v1/dispatches",
        headers={"Authorization": f"Bearer {os.environ['DISPATCH_TOKEN']}"},
        params=params,
    ).json()
    rows += page["dispatches"]
    cursor = page["nextCursor"]
    if cursor is None:
        break
print(len(rows))
```

## Pages stay stable while you read

Pages are cut on `createdAt` and then the id. A Dispatch created while you page is newer than your cursor, so it appears on no later page, and no row is skipped or repeated. Start again from the first page to see new ones.

## Filter the list

| Parameter | Values |
| --- | --- |
| `chain` | `base` or `solana` |
| `mode` | `managed` or `relay` |
| `status` | The top-level status, as Get a Dispatch reports it: `queued`, `broadcasting`, `confirmed`, `failed`, `partial`, `abandoned` or `cancelled`. `abandoned` matches only a Relay Dispatch. |
| `from`, `to` | ISO 8601 times on `createdAt`. `from` is inclusive and `to` exclusive. |

Filters combine. A value outside these is a `400`.

## A `status` filter can return a short page

The engine works out `confirmed`, `failed` and `partial` when it reads each row, so it cannot ask the database for them. With a `status` filter, one request reads at most 500 Dispatches looking for matches. If it stops there, it returns what it found with a `nextCursor`. A page can therefore be short, or even empty, and still not be the last. Keep paging until `nextCursor` is `null`.
