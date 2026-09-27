# A Chain Handler declares how many sends may overlap

The Coordinator sent a claimed batch's transactions one after another. That is required on Base, whose nonces must land in order. On Solana, `broadcast` waits for confirmation, so a large payout took one confirmation per bundle end to end, although Solana has no nonces and its bundles can be in flight together.

## Decision

- The Chain Handler interface gains an optional `maxConcurrentSends`. Absent means 1, so Base is unchanged.
- The Coordinator sends a batch's chunks through a pool of that size; each chunk keeps its own write-before-send order (ADR-0041).
- Solana declares 4 by default, set by `SOLANA_SEND_CONCURRENCY`. Measured on devnet: 40 payments in 5 bundles took 13.6s one at a time and 5.5s four at a time.
- Resubmission (ADR-0042) and Relay Dispatch stay sequential; neither is a bulk path.

## Consequences

- More simultaneous RPC and Signer load per worker, bounded by the setting; a rate-limited RPC may want it lower.
