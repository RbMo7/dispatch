Status: ready-for-agent

# Solana landing

## Problem Statement

The engine promises that every payment is delivered exactly once, even through crashes. On Solana today that promise has three holes:

1. **A re-signed transaction is never written down before it's sent.** When a transaction's blockhash expires, `SolanaChainHandler.broadcast` re-signs it with a fresh blockhash and sends the new version itself, inside one `broadcast` call. The Coordinator only learns the new hash when `broadcast` returns. A crash in between, or an ambiguous failure after the re-sign, leaves the row pointing at the dead original while the new version may land. ADR-0041 records both as known Solana caveats. The Call then reads `abandoned` or `failed` although it may have been paid, and a caller who resends pays twice.
2. **A sent transaction is sent exactly once.** `sendRawTransaction(..., { maxRetries: 0 })` and no resend while waiting. Under congestion leaders drop transactions routinely; standard practice is to resend the same signed bytes every couple of seconds until it lands or its blockhash expires. Today a single drop costs the full ~60–90s validity window before anything happens.
3. **No priority fees.** On mainnet under load, transactions without a compute-unit price are the first dropped.

A fourth, smaller one: after a worker restart the in-memory blockhash record is gone, so a transaction left in flight can't be proven expired and ends `abandoned` (ADR-0041's "Solana after a crash").

## Solution

- **Provable expiry becomes its own chain status, `EXPIRED`** (ADR-0042). `getStatus` reports it once a transaction's blockhash has provably passed its validity window with no status recorded: the transaction can never land. The Coordinator, not the handler, then resubmits the Managed Dispatch's Calls as a **new Transaction written down before it is sent** (ADR-0041), exactly like a fee-bump replacement (ADR-0037). The dead predecessor is `DROPPED` at once, since it can never land. Up to 3 resubmissions (today's `broadcast` refresh cap); after that, or for a Relay Dispatch (no key to re-sign with), the Call is `FAILED`, as ADR-0030 already reports.
- **`broadcast` no longer re-signs.** It sends, then waits for confirmation as today, resending the identical bytes every 2s while the blockhash is valid. On expiry it hands off (returns the same hash) and the Coordinator takes over. A "Blockhash not found" at send time is treated the same way, not as a terminal error: the validity window decides.
- **Restart restores the blockhash records.** The optional `reserveNonces` handler hook, which the worker calls once at start with every in-flight transaction's signed bytes, is renamed `restoreInFlight`. Base still reserves nonces from it; Solana re-learns each transaction's blockhash from the bytes, so expiry stays provable after a restart.
- **Priority fees, operator-configured, default off** (ADR-0003: nothing costs more by default). `SOLANA_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` > 0 prepends a `SetComputeUnitPrice` instruction to every transaction the engine builds. Relay Dispatch transactions are the caller's own and are never touched.

Resubmitting after expiry is on regardless of Retry Policy: an expired Solana transaction was never included, so it was never charged, and the resubmission costs exactly what the original was authorized to. The price is the same configured one; escalating it is cost-increasing and out of scope.

## User Stories

1. As an integrator paying recipients on Solana, I want a transaction dropped under congestion to be resent automatically, so that a busy leader doesn't cost me a 90-second delay.
2. As an integrator, I want a payment whose transaction expired to be resubmitted automatically, so that "delivers every payment" holds without me watching for failures.
3. As an integrator, I want every resubmitted transaction written down before it is sent, so that a crash can never leave a paid Call reported as unpaid and tempt me into paying twice.
4. As an integrator, I want a Call that exhausted its resubmissions reported `failed` with a clear expiry reason, so that I know it provably never landed.
5. As a Relay Dispatch integrator, I want my expired transaction reported `failed`, never re-signed, so that nothing executes that my user didn't sign.
6. As an operator, I want to set a Solana priority fee, so that my transactions land on a congested mainnet.
7. As an operator, I want that fee off unless I set it, so that nothing costs more than I authorized.
8. As an operator restarting a worker, I want in-flight Solana transactions still resolved to confirmed, resubmitted or failed, never `abandoned` just because the process restarted.
9. As a contributor, I want provable expiry expressed as a chain status the Coordinator acts on, so that resubmission runs through the same written-down-first pipeline as every other send.

## Implementation Decisions

- `ChainStatus` gains `'EXPIRED'`: "provably can never land". Only a chain with such a proof reports it (Solana). The conformance contract (never `CONFIRMED` for a never-broadcast hash) is unchanged.
- Coordinator: `tryResolveVersions` reports `'expired'` when the latest version is `EXPIRED`. `resolvePendingTransaction` then resubmits every PENDING row sharing the hash (a bundle is resubmitted together): re-`prepare` their original Calls, `sign`, `transactionHash`, `createReplacementTransaction` per member, `markDropped` the predecessor, `broadcast`, `recordSent`. Nothing new on the handler interface: re-preparing the stored Calls is enough.
- The resubmission count reuses the replacement counter `feeBumpAttempts` (a replacement is a replacement); no migration.
- A failed re-sign (Signer down) leaves the expired row `PENDING` and retries next tick. Nothing is lost: the original provably can't land.
- A rewatched `ABANDONED` transaction that reports `EXPIRED` is marked `FAILED`, as a `FAILED` status was before.
- `SolanaChainHandler`: `BlockhashRecord.resignable` and `resignWithFreshBlockhash` are deleted. `broadcast` keeps its HTTP-only wait loop (never `confirmTransaction`), resending identical bytes every 2s.
- `MAX_BUNDLE_SIZE` (8) keeps its margin: the compute-budget instruction adds ~45 bytes to a worst case measured well under 1232.

## Testing Decisions

- Coordinator (fake store, stub handler, offline tier): expired → resubmitted, written down before send, predecessor `DROPPED`; bundle members resubmitted as one; cap reached → `FAILED`; Relay → `FAILED`; sign failure → stays `PENDING`; restart hook renamed.
- Solana handler, live devnet (ADR-0013): `blockhash-retry.test.ts` rewritten — bytes held past expiry are handed off (same hash) and `getStatus` reports `EXPIRED`; a priority-fee transaction lands and carries the compute-budget instruction; `restoreInFlight` lets a fresh handler instance prove expiry.

## Out of Scope

- Escalating the priority fee on resubmission (cost-increasing; would follow ADR-0037's Retry Policy gating).
- Dynamic priority-fee estimation (`getRecentPrioritizationFees`), `SetComputeUnitLimit`, Jito bundles.
- Durable Nonce Execution (ADR-0007, still opt-in and unbuilt).
- Worker throughput: `broadcast` still waits for confirmation, so Solana sends stay sequential per worker.
