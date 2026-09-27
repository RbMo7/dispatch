# The Funding Check counts what sending costs, not only what is paid

The Funding Check (ADR-0024) summed payment amounts per asset. On Solana that misses the SOL a payout costs to send: a base fee per transaction, the priority fee, and rent for every recipient token account a token payment creates (about 0.002 SOL each). A 300-recipient token payout from a Sender holding enough tokens but too little SOL passed the check and then failed partway through, which is the outcome the check exists to prevent.

## Decision

- The Chain Handler interface gains an optional `networkCost(calls, senderAddress)`: the native-asset cost of sending those Calls beyond what their payments move. The Coordinator adds it to the Sender's requirement for that asset before anything is signed.
- Every Call of the chain in the claimed batch shares the cost, so a shortfall fails them all with `INSUFFICIENT_FUNDS`. A Call already failed by another requirement is never failed twice. A `networkCost` that can't be computed (RPC down) fails the Calls, as an unreadable balance already does.
- Solana's estimate: the base fee for each transaction `prepare` would build, the priority fee at its worst case (all 1.4M compute units at the configured price, or the ceiling of an automatic one), and rent for each recipient token account that doesn't exist yet, sized by its token program and mint. It can over-ask, never under-ask.
- Base doesn't implement it yet; its gas would use the same method.

## Consequences

- One extra batched account lookup per 100 token recipients, in the claim step.
- With a high priority-fee price, the worst-case estimate can refuse a batch that would have fit, since real compute usage is set from simulation (#37) and is far below 1.4M units.
