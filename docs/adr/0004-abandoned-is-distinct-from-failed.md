# ABANDONED is a separate terminal status from FAILED

An EVM transaction that never confirms within its timeout (Retry Policy off, see ADR-0003) is not provably dead the way an expired Solana blockhash is — it can still sit in the mempool and confirm hours later with no engine involvement at all. Marking it `FAILED` after a timeout would be a false-confidence signal: a caller who sees `FAILED` and safely resends the same payment risks paying the recipient twice if the original transaction later confirms anyway. `ABANDONED` means "we stopped watching without a definitive outcome," `FAILED` means "the chain itself rejected or reverted it" — the engine keeps a bounded, low-frequency background check on an `ABANDONED` transaction and reports if it confirms after all.

## Consequences

The default abandonment timeout is chain-aware, not a single global constant: Solana's is pinned to its blockhash-expiry deadline (a provable dead-end), EVM's is a longer, probabilistic default (e.g. ~10-15 minutes) since there is no hard deadline, only a growing likelihood the transaction is dead. Exact numbers are tunable per request; the chain-aware shape of the default is the actual decision recorded here.
