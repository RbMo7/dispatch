Status: ready-for-agent

# Solana hardening

## Problem Statement

After `solana-landing`, Solana still has gaps a real payout hits:

- The Funding Check (ADR-0024) compares token amounts against token balances but never checks the Sender has the SOL for fees, the priority fee, and rent for each recipient token account the payout creates (~0.002 SOL each). A short Sender fails payments mid-batch instead of being refused up front.
- Token-2022 tokens (e.g. PYUSD) can't be paid out: SPL payments assume the classic Token program.
- Sends are sequential: `broadcast` waits for confirmation, and the Coordinator sends a batch's transactions one after another.
- The priority fee is a fixed number, too high in quiet times and too low under congestion.
- The 500-payment volume run hasn't been re-run since `broadcast` changed.

## Solution

- **#39** Re-run the volume test; fix what it finds.
- **#40** An optional Chain Handler method, `networkCost(calls, senderAddress)`, returns the native-asset cost of sending those Calls beyond what their payments move. The Coordinator adds it to the Sender's native requirement before anything is signed (ADR-0043). Solana counts the base fee per transaction (bundles from `prepare`), the worst-case priority fee, and rent for each destination token account that doesn't exist yet (batched `getMultipleAccountsInfo`). Base doesn't implement it yet.
- **#41** `SOLANA_KNOWN_TOKENS` entries take an optional program (`SYMBOL:mint:decimals:token-2022`). Derivation, create-ATA, `transferChecked`, validation, `getBalance` and rent follow the token's program. Transfer-hook mints (extra accounts) stay unsupported.
- **#42** A Chain Handler may declare `maxConcurrentSends` (default 1, so Base stays sequential); the Coordinator sends a batch's chunks through a pool of that size (ADR-0044). `SOLANA_SEND_CONCURRENCY` configures Solana's.
- **#43** `SOLANA_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS=auto` with a required `SOLANA_MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS`: `sign` prices from `getRecentPrioritizationFees` for the transaction's writable accounts (75th percentile), clamped to the ceiling. Opt-in (ADR-0003); the Funding Check uses the ceiling. A resubmission re-estimates.
- **#44** Durable Nonce Execution is filed but needs a design decision first: without expiry, ADR-0042's safe resubmission doesn't apply.

## Implementation Decisions

- A native-cost shortfall fails every Call of that chain in the claimed batch: the fees are shared, so no single Call is the one that doesn't fit. A Call already failed by another requirement is never failed twice.
- The priority fee is estimated at the worst case (full 1.4M compute units at the configured or ceiling price), so the check can only over-ask, never let a batch start that can't finish.
- Concurrency lives in the Coordinator's chunk loop only; resubmission and Relay Dispatch stay sequential.

## Testing Decisions

- Offline: Coordinator funding with a `networkCost` stub (shortfall refused, covered passes, no double failure); pool overlap and limit; auto-price percentile and clamp; Token-2022 config parsing.
- Live devnet: rent for a new ATA matches the estimate; a Token-2022 payment to a new recipient lands; an `auto` transaction lands; the volume run with concurrency.

## Out of Scope

- Base's `networkCost` (gas) — same interface, its own ticket.
- Transfer-hook Token-2022 mints; confidential transfers.
- Raising the priority fee beyond the estimate on resubmission (cost-increasing, would need Retry Policy).
