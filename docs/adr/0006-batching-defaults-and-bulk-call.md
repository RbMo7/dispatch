# Sequential-per-payment is the default batching mode; Bulk Call is opt-in and caller-owned

For a Managed Dispatch batch (e.g. 1000 payments), the default is one transaction per payment, sent sequentially under the Sender's own nonce sequence — already safe given the atomic nonce counter, and ships with no new on-chain dependency. Bulk Call (encoding multiple payments as one call against an aggregator/multicall contract) is opt-in per request, and the engine only ever encodes against a **caller-supplied** contract address — it never deploys, owns, or maintains a fund-touching contract itself, since that would be a custody/audit liability well beyond "handling transaction submission."

## Consequences

Solana needs no separate Bulk Call concept: a Solana transaction already natively bundles multiple instructions atomically, so its existing per-transaction chunking *is* its bulk mode. Bulk Call as specified here is EVM-specific.
