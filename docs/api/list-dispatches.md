# List Dispatches

## `GET /v1/dispatches`

Lists Managed and Relay Dispatches together, newest first, a page at a time. Needs the `Authorization` header.

### Query parameters

All are optional.

| Parameter | Values | Default |
| --- | --- | --- |
| `limit` | Rows per page, 1 to 100 | 25 |
| `cursor` | The `nextCursor` of the previous page. Opaque: pass it back as it came. | First page |
| `chain` | `base` or `solana` | Both |
| `mode` | `managed` or `relay` | Both |
| `status` | The top-level status as [`GET /v1/dispatch/:id`](./get-dispatch.md) reports it, derived ones included: `queued`, `broadcasting`, `confirmed`, `failed`, `partial`, `abandoned` or `cancelled`. `abandoned` matches only a Relay Dispatch. | All |
| `from`, `to` | ISO 8601 timestamps on `createdAt`. `from` is inclusive and `to` exclusive. | No bound |

A value outside these is a `400`. Parameters not listed here are ignored.

### Example

```sh
curl -s "$DISPATCH_URL/v1/dispatches?limit=3" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatches": [
    {
      "dispatchId": "63012091-b4ab-4942-8a1f-b3fbc5c9037e",
      "mode": "managed",
      "chain": "base",
      "status": "cancelled",
      "createdAt": "2026-10-31T18:48:30.377Z",
      "itemCount": 1,
      "totals": [{ "asset": "ETH", "amount": "10000000000000", "decimals": 18 }]
    },
    {
      "dispatchId": "e20854e7-dd43-4895-97cb-24878d60c974",
      "mode": "relay",
      "chain": "solana",
      "status": "confirmed",
      "transactionHash": "25bQXhmDop8N3gnimF3UXRssBkdJf1TmpUoREp26pogeqn8rEvv7q5GqdTTuKT5Tv47u9iDCnBGDLgAfms7zP98R",
      "error": null,
      "createdAt": "2026-10-31T18:48:30.365Z",
      "itemCount": 1,
      "totals": []
    },
    {
      "dispatchId": "4ecfe1aa-852d-4ef9-91f2-c78fb1690b75",
      "mode": "relay",
      "chain": "base",
      "status": "confirmed",
      "transactionHash": "0x3e28307d8fae837fc7f8c54906f0ba7c7d737dcaf6c628b9f2d6c4158398566c",
      "error": null,
      "createdAt": "2026-10-31T18:48:30.348Z",
      "itemCount": 1,
      "totals": []
    }
  ],
  "nextCursor": "WyIyMDI2LTEwLTMxVDE4OjQ4OjMwLjM0ODc4NVoiLCI0ZWNmZTFhYS04NTJkLTRlZjktOTFmMi1jNzhmYjE2OTBiNzUiXQ"
}
```

Filters combine. This finds every partly failed Dispatch on Base:

```sh
curl -s "$DISPATCH_URL/v1/dispatches?chain=base&status=partial" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

```json
{
  "dispatches": [
    {
      "dispatchId": "651d094d-00de-4dc6-a7c4-0ec2dc98b610",
      "mode": "managed",
      "chain": "base",
      "status": "partial",
      "createdAt": "2026-10-31T18:48:28.001Z",
      "itemCount": 2,
      "totals": [
        { "asset": "ETH", "amount": "50000000000000", "decimals": 18 },
        { "asset": "USDC", "amount": "40000000", "decimals": 6 }
      ]
    }
  ],
  "nextCursor": null
}
```

### Rows

Each row is the `GET /v1/dispatch/:id` body without `items`, plus:

| Field | Means |
| --- | --- |
| `chain` | `base` or `solana` |
| `createdAt` | When `POST /v1/dispatch` stored it |
| `itemCount` | How many items it has. A Relay Dispatch has 1. |
| `totals` | The sum per asset of the `payment` items, in the asset's smallest unit, each with the asset's `decimals` as on a `payment` item. `call` items carry no amount, and a Relay Dispatch has none, so its `totals` is empty. |

A Relay row also has `transactionHash` and `error`, as its single status does.

### Paging

Pass `nextCursor` back as `cursor` to get the next page. `nextCursor` is `null` on the last page, and only there.

Pages are cut on `(createdAt, id)`, so a Dispatch created while you page appears on no later page, and none is skipped or repeated.

A `status` filter is applied after the engine reads each row, so one request reads at most 500 Dispatches looking for matches. When it stops there, it returns what it found with a `nextCursor`. A page can therefore be short, or even empty, and still not be the last. Keep paging until `nextCursor` is `null`.

### Errors

| Status | Body | Cause |
| --- | --- | --- |
| `400` | `{ "statusCode": 400, "code": "FST_ERR_VALIDATION", "error": "Bad Request", "message": "querystring/status must be equal to one of the allowed values" }` | `status=done` |
| `400` | `{ "statusCode": 400, "code": "FST_ERR_VALIDATION", "error": "Bad Request", "message": "querystring/limit must be <= 100" }` | `limit=500` |
| `400` | `{ "error": "from must be an ISO 8601 timestamp" }` | `from=yesterday` |
| `401` | `{ "error": "unauthorized" }` | Missing or wrong `AUTH_TOKEN` |
