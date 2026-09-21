Status: blocked-by-core-scaffold

# Solana Chain Handler

## Problem Statement

The first real Chain Handler, plugging into the scaffold from `.scratch/core-engine-scaffold/`. Solana was chosen to go first. Its concurrency model is structurally different from EVM's (no account nonce — a time-bounded recent blockhash, ~150 slots — see ADR-0007 and CONTEXT.md's Chain Handler entry), which is exactly why building it first is a good proof of the Chain Handler seam: nothing about the Coordinator, the Signer contract, or the conformance suite should need to change to accommodate it.

## Solution

A `SolanaChainHandler` satisfying the Chain Handler interface (`.scratch/core-engine-scaffold/issues/05`) and passing its conformance suite, covering native SOL transfers and SPL token transfers (USDC first), blockhash-refresh-and-resubmit as the default retry mode (ADR-0007), and status/confirmation tracking against Solana's own commitment levels (`processed`/`confirmed`/`finalized`). Tested against real solana-devnet RPC calls per ADR-0013 — no fake chain behavior.

## Out of Scope

- Durable Nonce Execution (ADR-0007) — opt-in mode, later.
- Bulk Call / any batching mode beyond Solana's native multi-instruction-per-transaction bundling.
- Sender Pool (ADR-0016).
- Mainnet — devnet only for this phase; going to mainnet is a config change (ADR-0017), not new code, once this is solid.
- Relay Dispatch's Solana path (accepting an already-signed transaction) — Managed Dispatch only for now.
