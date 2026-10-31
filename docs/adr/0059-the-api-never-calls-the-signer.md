# The API never calls the Signer; the worker records what it read

Accepted 2026-11-01. Keeps ADR-0046's network boundary; amends how `GET /v1/senders` (#111) gets a key's pins.

The console's Senders view shows each Signer key's pins. The first version had the API process call the Signer's `GET /keys/{address}/policy` itself. That put the Signer's bearer token in the API process, the one that faces callers, and made the Signer reachable from it. The mainnet checklist says the Signer is reachable only from the worker, so that a compromised API cannot ask for a signature.

## Decision

- **The API process holds no Signer URL or token, and never calls the Signer.**
- **The worker reads each Sender key's pins** at startup (as ADR-0055 already does for a Multisig Sender, now for every Sender) and again every five minutes, and records the result per chain and address: the pins, or the error, and when it read them.
- **`GET /v1/senders` reads that record** and reports when it was taken. Before the worker's first read it says the key has not been read yet.

## Considered options

- **Let the API call the Signer** (the first version). Rejected: it widens the Signer's exposure to the process that faces callers, against ADR-0046 and the mainnet checklist, to show a few read-only fields.
- **Drop the Signer block from the console.** Rejected: whether a Multisig Sender's key is pinned is the check an operator most wants to see.

## Consequences

- The Senders view can be up to five minutes behind a Signer policy change; it shows the time of the last read.
- One small table, written only by the worker.
