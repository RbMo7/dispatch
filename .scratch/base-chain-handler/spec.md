Status: ready-for-agent

# Base Chain Handler

## Problem Statement

Today Dispatch only moves money on Solana. Anyone who needs Managed Dispatch payouts, opt-in fee-bump retry, batched payments, or Relay Dispatch broadcasting on Base — an operator running a payroll/disbursement app, a DEX relaying its users' own signed trades, a wallet backend — has no chain to point at. Base was chosen as the second chain because it's the highest-volume, cheapest-fee EVM network with genuinely different mechanics from Solana (an account nonce instead of a time-boxed blockhash; a fee market instead of a fixed fee; an L1-data-fee component and multi-stage confirmation model with no Solana analogue) — precisely the kind of second real chain that proves the Chain Handler seam generalizes rather than being accidentally Solana-shaped.

## Solution

A `BaseChainHandler` satisfying the existing `ChainHandler` interface (`src/chain-handler/chain-handler.ts`) and its conformance suite (ADR-0015) — the same interface `SolanaChainHandler` already implements, unchanged by this work. Registered under a new `base` Chain identity, config-activated like every other chain (ADR-0019). Base and Ethereum L1 are separate Chain identities (ADR-0035, written during this feature's design pass) — this spec covers `base` only; Ethereum L1 is a distinct, undesigned future feature.

Not built in one pass — each concern is its own issue, in dependency order, mirroring `solana-chain-handler`'s own precedent (its 12 build issues plus the two Relay Dispatch issues added when that interface grew):

1. Domain/config plumbing — the `base` Chain identity, its config shape (RPC URL, chain ID, Sender address, known ERC-20 tokens, fee-bump percentage default, Bulk Call default batch size), and registry wiring (depends on nothing else; unblocks everything below).
2. Chain-ID verification and startup wiring — `eth_chainId` checked against configured chain ID at construction, refuses to start on mismatch.
3. Nonce authority — the per-Sender internal next-nonce counter, initialized/resynced from `eth_getTransactionCount`, with its nonce→transaction-hash history persisted as it goes.
4. `paymentToCall` — native ETH and ERC-20 `transfer` encoding (ADR-0028 precedent).
5. `validateCall` — cheap shape validation for `EvmCall` (address/data shape, no RPC).
6. `prepare` — unsigned EIP-1559 transaction building, including the fixed-multiplier fee-estimation heuristic and L1-data-fee-aware gas accounting.
7. `sign` — wiring to the Signer client (ADR-0002), symmetric to Solana's.
8. `broadcast` (happy path) — `eth_sendRawTransaction`, recording the Transaction.
9. Fee-bump retry — Retry Policy's EVM shape: a new Transaction at the same nonce with both fee fields bumped by the configured percentage.
10. `getStatus` and confirmation tracking — `CONFIRMED` at L2 block inclusion (~2s), `FAILED` on a reverted receipt, `PENDING`/`ABANDONED` via the existing generic timeout (ADR-0004) — plus the reorg safety-net re-check described below.
11. Reorg safety net — the low-frequency background re-check that verifies an already-`CONFIRMED` Base transaction is still present once its block reaches the OP Stack "safe" head, same shape as the existing `ABANDONED` re-watch (`core-engine-scaffold` issue 10), flagging/reopening it if it isn't.
12. Error mapping — a dedicated pass mapping RPC/receipt failure modes to `DispatchError` codes (dedicated pass, not inline per earlier issue, mirroring Solana issue 09).
13. `validateSignedTransaction` and Relay Dispatch's Base path — EIP-1559 type-`0x02` decode, signing-hash recompute, sender recovery, chain-ID check, all RPC-free (ADR-0032 precedent); `broadcast`/`getStatus` deriving bookkeeping from externally-signed bytes with no RPC (ADR-0033 precedent) — Base gets both interface methods in this same pass rather than as a follow-on, since the interface already requires them for every chain.
14. Bulk Call — `aggregate3Value` encoding against a caller-supplied Multicall3-shaped aggregator address, per-item `allowFailure: true`, operator/request-configurable max batch size.
15. Conformance suite validation — `BaseChainHandler` passes the same shared suite Solana does, no chain-specific carve-outs.
16. Base Sepolia volume test — the actual proof this is done, mirroring Solana issue 12's devnet volume test.

Tested against real Base Sepolia RPC throughout (ADR-0013's two-tier discipline extended to a second chain) — no fake chain behavior at any stage past pure encoding/decoding logic.

## User Stories

1. As an operator, I want to configure Base as an enabled chain the same way Solana is configured, so that enabling a second chain is a config change, not new orchestration code (ADR-0019).
2. As an integrator, I want to send a Managed Dispatch `POST /v1/dispatch` with `"chain": "base"` and a native ETH payment, so that I can pay out ETH the same way I already pay out SOL.
3. As an integrator, I want to send a Managed Dispatch with an ERC-20 payment (e.g. USDC on Base), so that I can pay out tokens without hand-encoding the `transfer` call myself.
4. As an integrator, I want to submit a raw `EvmCall` (`{to, data, value}`) for anything beyond a plain transfer, so that a contract interaction I've already encoded myself gets submitted exactly as I built it (ADR-0018/0027).
5. As an integrator, I want a batch of many payments sent sequentially, one transaction per payment, by default, so that a partial failure in the batch never blocks or corrupts the rest (ADR-0006's default mode, unchanged from today).
6. As an integrator with a large batch, I want to opt into Bulk Call and have my payments bundled into fewer transactions against my own aggregator contract, so that I pay less in aggregate transaction overhead.
7. As that same integrator, I want one bad payment inside a Bulk Call bundle to fail on its own without taking down the other payments in the same bundle, so that Bulk Call never becomes less reliable than one-tx-per-payment.
8. As an integrator with a very large batch, I want Bulk Call to split across multiple transactions once a configurable size limit is hit, so that I don't have to reason about gas/calldata limits myself.
9. As an integrator, I want `retryPolicy: true` to let the engine fee-bump a stuck Base transaction, so that a transaction that's been undervalued for the current fee market still eventually lands.
10. As that integrator, I want the fee-bump percentage the engine uses to be something I (or my operator) can configure, so that I'm not stuck with a number tuned for a different network's mempool behavior.
11. As an integrator, I want a fee-bump to show up as a new Transaction at the same nonce, never a mutation of the original, so that my transaction history stays honest about what was actually broadcast (CONTEXT.md's Attempt-vs-Transaction split).
12. As an integrator, I want status polling to report `confirmed` within a couple of seconds of real on-chain inclusion, so that Base's actual speed isn't hidden behind an unnecessarily conservative status policy.
13. As that same integrator, I want the rare case where a "confirmed" Base transaction gets reorged out to be caught and reflected in my transaction's status, so that "confirmed" isn't a guarantee the engine quietly can't back up.
14. As an integrator, I want a transaction the chain actually reverted to be reported as `failed`, distinct from one the engine simply stopped watching (`abandoned`), so that I know whether the chain gave a definitive answer.
15. As an integrator whose transaction never gets a receipt, I want it to eventually stop being tracked (`abandoned`) rather than polled forever, while being told honestly that the engine doesn't have proof of the outcome.
16. As an operator, I want the Funding Check (ADR-0024) to work against Base balances (native ETH and ERC-20) before a batch is claimed, so that a batch fails fast on insufficient funds instead of partially executing.
17. As an application whose end users bring their own wallets, I want to hand the engine an already-signed Base transaction via Relay Dispatch, so that I get the same reliable broadcast-and-track behavior Solana Relay Dispatch already gives me.
18. As that integrator, I want a malformed or wrong-chain-ID signed transaction rejected immediately with a clear error, not silently queued and failed later.
19. As that integrator, I want my transaction's confirmation tracking on Relay Dispatch to behave identically to Managed Dispatch's, so I don't need chain-specific or mode-specific polling logic.
20. As an integrator, I want to know a legacy or EIP-2930-typed signed transaction is explicitly rejected (not silently mis-decoded) if I submit one to Relay Dispatch, so that I get a clear error telling me to sign the modern format instead.
21. As a contributor, I want `BaseChainHandler` to pass the exact same `ChainHandler` conformance suite `SolanaChainHandler` does, so that adding this chain never required special-casing the interface.
22. As a contributor, I want the Coordinator, Signer contract, and API routes to require zero Base-specific code, so that this chain is provably just another interface implementation, not a fork of the orchestration layer.
23. As a contributor, I want the engine's own nonce tracking, not a per-request RPC read, to be the source of truth for the next nonce under concurrent Managed Dispatch submissions, so that concurrent payments from the same Sender never collide or skip.
24. As a maintainer, I want the chain ID baked into every transaction this handler builds, and verified against the configured RPC endpoint at startup, so that a misconfigured network can never sign and submit a transaction for the wrong chain.
25. As a maintainer, I want `base`'s config (RPC URL, chain ID, Sender address, known tokens, fee-bump default, Bulk Call default batch size) to follow the exact same shape Solana's config already does, so that operators configuring a second chain don't have to learn a new pattern.
26. As a maintainer, I want the persisted per-Sender nonce→transaction-hash history to exist now even though its resolution logic (the EVM analogue of ADR-0030) isn't built yet, so that a later issue can use it without a data-migration problem.

## Implementation Decisions

- **Chain identity**: a new `base` value replaces the placeholder `evm` value in the `Chain` union and `ChainRegistry`'s known-chains list (both currently `'evm' | 'solana'`) — `EvmCall`'s shape (`{to, data, value}`) is unchanged and correctly named (it's still the EVM wire shape; `base` is the Chain, not a new Call shape). `docs/api.md`'s wire examples referencing `"evm"` as the chain string are corrected to `"base"` as part of this decision (done as part of this design pass, alongside ADR-0035 and the CONTEXT.md update).
- **Library**: `viem` is the EVM library (RLP/typed-transaction serialize+parse, ABI encode/decode, `secp256k1` sender recovery via `recoverTransactionAddress`, a JSON-RPC `publicClient`) — no EVM library exists in this repo's dependencies yet; this is a new addition, chosen for being TypeScript-first and covering every primitive this handler needs (transaction building/decoding, ABI encoding, RPC transport) without a second library for any of them.
- **Nonce authority**: `BaseChainHandler` holds an in-memory per-Sender next-nonce counter (this build has exactly one Sender per ADR-0016's current single-Sender scope), initialized from `eth_getTransactionCount(sender, "latest")` on construction and resynced the same way if a broadcast fails with a nonce-mismatch-shaped RPC error. Every successful `broadcast` also appends `(nonce, hash)` to a persisted per-Sender history — the byproduct decision #6 from the grill session, consumed by no logic yet.
- **Fee estimation (`prepare`)**: reads the latest block's `baseFeePerGas` once per `prepare` call, sets `maxFeePerGas` to a fixed multiplier over it (documented constant, not derived from `eth_feeHistory` percentiles) and `maxPriorityFeePerGas` to a fixed/configured tip. No pluggable estimator interface.
- **Chain ID**: baked into every built transaction as an explicit EIP-1559 field; verified against `eth_chainId` once at handler construction, refusing to start on mismatch. Base mainnet = 8453, Base Sepolia = 84532 — both are config values within the one `base` Chain (ADR-0035), not separate Chain identities.
- **`validateSignedTransaction`**: decodes the type byte (EIP-2718), accepts type `0x02` only (rejects legacy and type `0x01` with a structured `DispatchError`), recomputes the EIP-1559 signing hash, recovers the sender address, and checks the decoded chain ID against the configured network — no RPC round-trip, mirroring `SolanaChainHandler`'s no-RPC validation discipline.
- **`broadcast`/`getStatus` for externally-signed transactions**: `broadcast` decodes nonce and chain ID directly from signed bytes it didn't itself produce (no RPC needed, ADR-0033 precedent) so Relay Dispatch transactions get the same nonce-history bookkeeping Managed Dispatch ones do.
- **`getStatus` / confirmation policy**: `status: 1` on `eth_getTransactionReceipt` → `CONFIRMED`, reported as soon as the transaction's block is included (~2s), deliberately not waiting for OP Stack "safe" head — this is the speed Base is chosen for. `status: 0` → `FAILED`. `null` receipt is `PENDING` until the Coordinator's existing generic abandonment timeout (ADR-0004) fires, then `ABANDONED`.
- **Reorg safety net**: once a Base transaction is marked `CONFIRMED`, a low-frequency background check (same polling shape as the `ABANDONED` re-watch mechanism, `core-engine-scaffold` issue 10 — a bounded-window, infrequent re-check, not the same trigger condition) re-verifies the transaction's receipt is still present once its block number is at or below the current OP Stack "safe" head. If it's gone, the transaction is reopened/flagged rather than left silently wrong. This check never gates or delays the initial `CONFIRMED` report.
- **`paymentToCall`**: native ETH → `{to: recipient, data: "0x", value: amount}`. A known ERC-20 asset → `{to: tokenContractAddress, data: <0xa9059cbb + left-padded recipient + big-endian uint256 amount>, value: "0"}`, symmetric to `SolanaChainHandler.paymentToCall`'s SPL-transfer split. An unrecognized asset answers `UNKNOWN_ASSET` (ADR-0029), unchanged pattern from Solana.
- **`getBalance`**: native ETH via `eth_getBalance`; a known ERC-20 token via a `balanceOf` `eth_call` — symmetric to Solana's native-lamports-vs-ATA split, feeding the Funding Check (ADR-0024) unchanged.
- **Fee-bump / Retry Policy**: the minimum bump percentage applied to both `maxFeePerGas` and `maxPriorityFeePerGas` on a replacement is operator-configurable with a documented default slightly above go-ethereum/op-geth's inherited `PriceBump: 10` floor (their default, confirmed unchanged in `op-geth`'s fork — not a verified Base-sequencer-level guarantee, stated as such rather than overclaimed). A fee-bump always produces a new Transaction row at the same nonce, never a mutation of the original (CONTEXT.md's Attempt-vs-Transaction split).
- **Bulk Call**: an opt-in-per-request Managed Dispatch mode (ADR-0006) — the request supplies a caller-owned aggregator contract address plus the payments/calls to bundle; `BaseChainHandler` builds `Call3Value[]` and encodes `aggregate3Value(...)` against Multicall3's known interface (deployed at the same address, `0xcA11bde05977b3631167028862bE2a173976CA11`, on Base). Every item gets `allowFailure: true`; each bundled payment's own confirmed/failed outcome is read back from the transaction's `Result[]` return data, not just the top-level receipt status. Max items per Bulk Call transaction is a configurable batch size (operator default, optionally overridden per request) — once a batch exceeds it, the engine splits it across multiple Bulk Call transactions rather than one unbounded one.
- **EVM FAILED-vs-ABANDONED nonce proof (ADR-0030's EVM analogue)**: not built in this spec. The nonce→hash history above exists so a future issue can add it without new persisted state; `ABANDONED` handling here is exactly ADR-0004's existing generic timeout, nothing chain-specific added.

## Testing Decisions

Two-tier discipline unchanged (ADR-0013), extended to a second real chain: pure-unit tests for anything with no I/O, real infrastructure for everything else — no fake RPC/sequencer behavior stands in anywhere a real one is being tested.

- **Pure-unit, no RPC**: nonce-counter logic, the fee-estimation heuristic's math, ERC-20/`aggregate3Value` ABI encoding, `validateSignedTransaction`'s decode/signing-hash/recovery/chain-ID logic — all pure, local checks, mirroring how Solana's own decode/verify tests are structured (per `relay-dispatch/spec.md`'s testing note on `validateSignedTransaction`).
- **Real Base Sepolia RPC, mirroring Solana's real-devnet-throughout discipline**: `broadcast`, `getStatus` (including the reorg safety-net re-check), `getBalance`, chain-ID verification at construction, and the fee-bump retry path are all tested against real Base Sepolia — no mocked JSON-RPC responses standing in for actual chain behavior at any of these seams, exactly as `SolanaChainHandler`'s own tests run against real devnet.
- **Conformance suite**: `BaseChainHandler` runs the identical shared `ChainHandler` conformance suite `SolanaChainHandler` already passes (ADR-0015), including the `validateSignedTransaction`/broadcast-bookkeeping cases the suite already has from Relay Dispatch's design pass — no Base-specific suite fork.
- **Volume test**: a real Base Sepolia run analogous to Solana issue 12's devnet volume test — a batch large enough to exercise sequential dispatch, at least one Bulk Call bundle, and at least one fee-bump under real (if synthetic) fee pressure.

## Out of Scope

- Ethereum L1 — a separate, undesigned future feature, its own Chain Handler from scratch when someone builds it (ADR-0035).
- The EVM analogue of ADR-0030 (resolving a stuck Managed Dispatch transaction to `FAILED` via a higher-nonce-confirmed proof) — the nonce→hash history is persisted now; the resolution logic itself is deferred.
- `eth_feeHistory`-percentile-based fee estimation, or any pluggable fee-estimation strategy — the fixed-multiplier heuristic is the whole story for now.
- Legacy (type `0x00`) and EIP-2930 (type `0x01`) signed-transaction support in `validateSignedTransaction` — type `0x02` only.
- Sender Pool (ADR-0016) — single Sender, same as Solana today.
- Mainnet — Base Sepolia only for this phase; mainnet is a config change (ADR-0035/CONTEXT.md), not new code, once this is solid.
- Any shared "generic EVM" plumbing module reused by a future Ethereum L1 handler — not built speculatively (ADR-0012); revisit only once a second real EVM-family Chain Handler exists.

## Further Notes

Produced by a research → grilling → domain-modeling pass (`.scratch/base-chain-handler/research-base.md` for the primary-source technical grounding; ADR-0035 and the CONTEXT.md `Chain`/`Chain Handler` entry updates for the chain-family-split decision that came out of it). Per this repo's chain-specific review cadence (AGENTS.md), this spec's issues are worked through in one pass once broken out, not reviewed one-by-one like `core-engine-scaffold`'s were.

Broken into 14 tracer-bullet tickets via `/to-tickets`. Per a mid-stream convention change (docs/agents/issue-tracker.md), these are tracked as GitHub Issues on `RbMo7/dispatch`, not local `.scratch/base-chain-handler/issues/*.md` files — those 14 local files were already written and are kept as a frozen historical snapshot, not updated further. The live tickets, in dependency order (GitHub skipped issue number 12, a harmless numbering gap):

1. #1 — Chain plumbing, config & chain-ID verification
2. #2 — Nonce authority (blocked by #1)
3. #3 — Native ETH transfer, end to end (blocked by #2)
4. #4 — ERC-20 token transfer (blocked by #3)
5. #5 — Smart contract call submission, raw `EvmCall` (blocked by #3)
6. #6 — Status and confirmation tracking (blocked by #3)
7. #7 — Reorg safety net (blocked by #6)
8. #8 — `ABANDONED` timeout (blocked by #6)
9. #9 — Fee-bump retry (blocked by #6)
10. #10 — Error mapping (blocked by #3, #6, #9)
11. #11 — Bulk Call (blocked by #4, #5)
12. #13 — Relay Dispatch: validate and externally-signed bookkeeping (blocked by #6)
13. #14 — Conformance suite validation (blocked by #5, #7, #8, #9, #10, #11, #13)
14. #15 — Base Sepolia volume test (blocked by #14)
