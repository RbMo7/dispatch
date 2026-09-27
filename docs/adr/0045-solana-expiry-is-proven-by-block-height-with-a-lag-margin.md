# Solana expiry is proven by block height, with a margin for lagging nodes

ADR-0042 lets the Coordinator re-sign a Solana transaction once `getStatus` reports it `EXPIRED`, so a false `EXPIRED` pays the recipient twice. The mainnet review found two ways the old proof could be false. It trusted `isBlockhashValid`, which a load-balanced RPC's lagging node answers "invalid" for a blockhash it hasn't seen yet. And it read the status before the validity, so a transaction landing in its last valid blocks between the two calls read as "not found, and expired".

## Decision

- Expiry is proven only when the `confirmed` block height passes the transaction's last valid block height **plus 150 blocks** (about a minute). A lagging node reports a lower height, which can only delay the proof. The margin covers a node answering the status call from up to that far behind.
- The status is read again **after** the proof. A transaction that landed before expiry shows up then, and is never reported `EXPIRED`.
- The last valid height is exact for anything the handler signed (`getLatestBlockhash`). For bytes signed elsewhere (Relay Dispatch) or known before a restart, it's bounded from above by the tip when first seen plus 150, since a blockhash is never newer than the tip. So the proof may come late, never early.
- A durable-nonce transaction (`AdvanceNonceAccount` first) has no expiry at all. It stays `PENDING`, and the abandonment timeout and re-watch are its fallback. That timeout is now 15 minutes on Solana, well past the slowest proof.

## Consequences

- `EXPIRED`, and so a resubmission, comes about a minute later than before, and up to two minutes later for restored or relayed transactions.
- `isBlockhashValid` is no longer used.
