# Polling for results

The API answers `POST /v1/dispatch` before anything reaches the chain, and it has no webhooks yet. You learn the outcome by polling [Get a Dispatch](./openapi.yaml#get-a-dispatch) until the Dispatch is final.

## When to stop

A Managed Dispatch is final when its top-level `status` is `confirmed`, `partial`, `failed` or `cancelled`. While it reads `queued` or `broadcasting`, at least one item is still in progress. A Relay Dispatch is final when its status is anything but `queued` or `broadcasting`.

When the Dispatch is final, act on each item: record the `transactionHash` of a `confirmed` one, and read the `error` of the rest. [The Dispatch lifecycle](./lifecycle.md) says what each status means for your code.

## How often to ask

Confirmation takes seconds on both chains. In our test runs a payment confirmed 10 to 15 seconds after it was submitted. A few seconds between polls is plenty, and the console itself polls about every 2 seconds while anything it shows is in flight.

Back off for a Dispatch that waits on people. A Multisig Sender's items sit in `awaiting_approval` until the Approvers vote, which can take hours, so poll those every minute or so. `approval.deadline` on each item says when the engine stops waiting.

## A polling loop

This waits until the Dispatch is final and returns it:

```js title="JavaScript"
const FINAL = new Set(['confirmed', 'partial', 'failed', 'cancelled', 'abandoned']);

async function waitForDispatch(id, everyMs = 3000) {
  for (;;) {
    const response = await fetch(`${process.env.DISPATCH_URL}/v1/dispatch/${id}`, {
      headers: { Authorization: `Bearer ${process.env.DISPATCH_TOKEN}` },
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const dispatch = await response.json();
    if (FINAL.has(dispatch.status)) return dispatch;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

const dispatch = await waitForDispatch('1a2f3f9f-0e2e-461c-b12c-e31391f1d5b4');
for (const item of dispatch.items) console.log(item.status, item.transactionHash ?? item.error?.code);
```

```python title="Python"
import os
import time

import requests

FINAL = {"confirmed", "partial", "failed", "cancelled", "abandoned"}


def wait_for_dispatch(dispatch_id, every=3.0):
    while True:
        response = requests.get(
            f"{os.environ['DISPATCH_URL']}/v1/dispatch/{dispatch_id}",
            headers={"Authorization": f"Bearer {os.environ['DISPATCH_TOKEN']}"},
        )
        response.raise_for_status()
        dispatch = response.json()
        if dispatch["status"] in FINAL:
            return dispatch
        time.sleep(every)


dispatch = wait_for_dispatch("1a2f3f9f-0e2e-461c-b12c-e31391f1d5b4")
for item in dispatch["items"]:
    print(item["status"], item["transactionHash"] or item["error"]["code"])
```

For that Dispatch it prints:

```text
confirmed 0x7e00aec4eafe72c4c852ff1517ddc1492b4581f117e9a9bbd88602f674735896
failed INSUFFICIENT_FUNDS
```

## Keep polling an abandoned item, for a while

`abandoned` is final for the engine, not for the chain. A Base transaction the engine gave up on may still be mined, and a timed-out multisig Proposal may still be executed. The engine keeps watching both for a while and changes the item if it sees an outcome: a multisig item at most once, within 30 days of its deadline. If you need to know, poll an `abandoned` item now and then, and check the chain or the multisig before you send the payment again.

## Poll many Dispatches at once

To watch many Dispatches, read [List Dispatches](./openapi.yaml#list-dispatches) with `status=broadcasting`, or `status=queued`, instead of each one by id. Each row has the top-level status but not the items, so fetch a Dispatch by id once its row is final. [Pagination](./pagination.md) explains the cursor.
