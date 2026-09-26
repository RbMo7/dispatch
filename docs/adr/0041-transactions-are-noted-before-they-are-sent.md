# Transactions are written down before they are sent

The Coordinator used to broadcast first and save the Transaction row afterwards. Two things went wrong with that order:

- **Crash.** If the process died between the two steps, a transaction could be on-chain with no record of it. The item showed `queued` forever, and nobody could tell whether money had moved.
- **Timeout.** A broadcast that timed out was recorded as `FAILED`, even though it may have reached the node and landed. The engine was reporting a false outcome.

Related gaps:

- **Stuck claims.** A Dispatch claimed just before a crash stayed `broadcasting` forever with its items never sent.
- **Nonce reuse after restart.** On restart, Base reseeded its nonce counter from the confirmed count, so still-pending transactions' nonces could be handed out again.

## Decision

- **Write first, then send.** After signing, the Coordinator computes the transaction's hash from its signed bytes, using a new required `ChainHandler.transactionHash(signed)`. It saves the row as `PENDING` **before** broadcasting. It works the same way for Managed Dispatch, Relay Dispatch and fee-bump replacements (ADR-0037).
- **After a successful send**, the row is marked sent (`recordSent`). If Solana re-signed with a fresh blockhash while sending, the row takes the new hash.
- **Only a definite rejection fails.** A rejection by the node marks the rows `FAILED`, and the nonce is released per ADR-0039. A refused fee-bump replacement is undone: it becomes `DROPPED`, and its predecessor goes back to `PENDING`.
- **An ambiguous failure (`RPC_UNAVAILABLE`, e.g. a timeout) leaves the row `PENDING`.** The existing machinery then resolves it: status polling; on Base, rebroadcasting the identical bytes after `stuckAfterMs`; and the abandonment timeout. Rebroadcasting identical bytes is always safe, because it can only ever execute once.
- **Restart seeding (Base).** The nonce counter starts at the highest of three values: the confirmed count, the pending count, and one more than the highest nonce in `nonce_history`. `nonce_history` is now written at sign time, before sending, and a released nonce's entry is forgotten. So a nonce written down but never sent stays reserved for its own recovery.
- **Stale claims.** Dispatches and Relay Dispatches record `claimedAt`. A claim still `broadcasting` 5 minutes later with items that have no row is reclaimed, and only those items are processed. An item with no row was never sent, because nothing is sent without a row first, so this can't pay twice.

## Consequences

- **Required interface method.** `transactionHash` is required, unlike the optional methods of ADR-0037 and ADR-0038, because the Coordinator can't write the row first without it. Both chains compute it locally: Base as `keccak256` of the bytes, Solana as its first signature. It is purely additive to the Solana handler.
- **Solana after a crash.** A Solana transaction written down, never sent, and then followed by a crash ends `abandoned` rather than `failed`. The in-memory blockhash record that proves expiry doesn't survive a restart. That is never wrong about money.
- **Funding Check on reclaim.** Reclaimed items skip the Funding Check (it ran at the original claim), and their broadcast answers for any shortfall.
