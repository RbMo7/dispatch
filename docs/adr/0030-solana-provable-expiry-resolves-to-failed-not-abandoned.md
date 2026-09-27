# A stuck Solana transaction resolves to FAILED via provable blockhash expiry, never ABANDONED

> **Updated by ADR-0042 and ADR-0045.** Provable expiry is now its own chain status, `EXPIRED`, which the Coordinator turns into a resubmission (or `FAILED` when it can't resubmit). The proof is block height past the last valid one plus a lag margin, not `isBlockhashValid`. The abandonment fallback is 15 minutes, not 120 seconds. The reasoning below, that a proven dead end is a definitive outcome and not `ABANDONED`, still holds.

`solana-chain-handler` issue 08 asked the question the spec deliberately left open: does Solana even need `ABANDONED` (ADR-0004), or does its provable blockhash expiry (~150 slots, ~60-90s, ADR-0007) mean a clean `FAILED` is honestly available instead?

`FAILED` (ADR-0004) means the chain itself rejected the transaction; `ABANDONED` means the engine stopped watching without ever learning a definitive outcome. Those are genuinely different claims, and which one is true for a non-confirming Solana transaction is knowable, not a judgment call: once a transaction's blockhash has definitively passed its validity window and no signature status was ever recorded for it, Solana's own runtime guarantees that transaction can never be included in any future block. That is a definitive outcome — "this specific signed transaction is dead" — not "we're no longer sure." Reporting `ABANDONED` here would be strictly less honest than the `FAILED` the engine can actually prove.

EVM has no equivalent proof: a stuck EVM transaction might still land later (no account-nonce-independent expiry mechanism rules it out), which is exactly why `ABANDONED` exists in the first place (ADR-0004) — a distinct terminal state for "we don't actually know." Solana's blockhash model means that uncertainty never arises for a transaction *this handler broadcast itself*.

## Decision

`SolanaChainHandler.getStatus` (`solana-chain-handler.ts`) returns `FAILED` — a value `ChainStatus` already supports, no interface change — once a hash has no recorded signature status *and* its originating blockhash (tracked internally in `blockhashByHash`, populated by `sign`/`broadcast`) has been confirmed expired via `isBlockhashValid`. `ABANDONED` is never produced by this Chain Handler.

The Coordinator's generic `abandonmentTimeoutMs`-driven ABANDONED path (core-engine-scaffold `coordinator.ts`) is chain-agnostic and can't be removed just for Solana without special-casing the Coordinator itself — which ADR-0015 treats as a signal the interface is wrong, not something to do lightly. Solana's config value in that map is instead a pure fallback safety net, pinned generously past the blockhash window (120 seconds) for the one case `getStatus`'s own provable-expiry check can't cover: no recorded blockhash for the hash at all (a process restart lost `blockhashByHash`, or the signed bytes were never produced by this handler instance). In ordinary operation, `getStatus` itself resolves a stuck Solana transaction to `FAILED` well before that fallback timeout would ever fire.

## Consequences

A Solana Dispatch item can reach `abandoned` in `GET /v1/dispatch/:id` (docs/api.md) only in that degraded fallback case, never as Solana's normal resolution path — unlike EVM, where it's the expected outcome for Retry Policy off. `blockhashByHash` is in-memory and lost on restart; that only widens the fallback window, it never produces an incorrect `FAILED`.
