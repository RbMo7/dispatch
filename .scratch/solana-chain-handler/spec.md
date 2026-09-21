Status: blocked-by-core-scaffold

# Solana Chain Handler

## Problem Statement

The first real Chain Handler, plugging into the scaffold from `.scratch/core-engine-scaffold/`. Solana was chosen to go first. Its concurrency model is structurally different from EVM's (no account nonce — a time-bounded recent blockhash, ~150 slots — see ADR-0007 and CONTEXT.md's Chain Handler entry), which is exactly why building it first is a good proof of the Chain Handler seam: nothing about the Coordinator, the Signer contract, or the conformance suite should need to change to accommodate it.

## Solution

A `SolanaChainHandler` satisfying the Chain Handler interface (`.scratch/core-engine-scaffold/issues/05`) and passing its conformance suite. Not built in one pass — each concern is its own issue, in dependency order, because every one of them is independently load-bearing for a production tx engine and none should be proven only as a side effect of another:

1. `01` — Account resolution (ATA derivation, existence, idempotent create)
2. `02` — Native SOL transfer (build)
3. `03` — SPL token transfer (build, depends on 01)
4. `04` — Signing wiring
5. `05` — Broadcast (happy path)
6. `06` — Blockhash-refresh-and-resubmit retry
7. `07` — Status and confirmation tracking
8. `08` — `ABANDONED` timeout decision
9. `09` — Error mapping (dedicated pass, not inline per earlier issue)
10. `10` — Bundling multiple payments into one transaction
11. `11` — Conformance suite validation
12. `12` — Devnet volume test (the actual proof this is done)

Tested against real solana-devnet RPC calls throughout, per ADR-0013 — no fake chain behavior at any stage.

## Out of Scope

- Durable Nonce Execution (ADR-0007) — opt-in mode, later.
- Bulk Call / any batching mode beyond Solana's native multi-instruction-per-transaction bundling.
- Sender Pool (ADR-0016).
- Mainnet — devnet only for this phase; going to mainnet is a config change (ADR-0017), not new code, once this is solid.
- Relay Dispatch's Solana path (accepting an already-signed transaction) — Managed Dispatch only for now.
