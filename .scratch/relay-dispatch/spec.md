Status: ready-for-agent

# Relay Dispatch

## Problem Statement

An application whose own end users bring their own wallets — a DEX where each trader signs their own trade, an NFT mint where the buyer signs, a wallet app relaying its users' transactions — needs somewhere to hand an already-signed transaction and trust it'll actually land: retried if the network drops it, tracked until it confirms, reported honestly if it can't. Managed Dispatch (the engine building and signing from a wallet it controls) doesn't fit this shape at all — there's no key for the engine to hold, no nonce for it to own, nothing for it to fee-bump. Today the engine has no way to serve this caller.

## Solution

A second dispatch mode on the same `POST /v1/dispatch` endpoint an integrator already knows — not a separate product to learn. A new optional `mode` field (`"managed" | "relay"`) defaults to `"managed"` when omitted, so every existing caller keeps working unchanged. `mode: "relay"` carries `{ chain, signedTransaction }` in place of `items`: no `Call`/`Payment`, no `retryPolicy` (there's no key to fee-bump with), no Funding Check (nothing here is the engine's own money).

The engine validates the signed transaction's shape cheaply before ever persisting it — a real check, not a rubber stamp, so a malformed submission gets `400` immediately instead of sitting as a queued row that only fails later. Once accepted, it's broadcast, retried with the *identical signed bytes* on a transient send failure (never a fee-bump, never a new signature — the engine has no key to produce one), and tracked to a terminal state through the exact same machinery Managed Dispatch already uses: the same `Coordinator` poll loop, the same `Transaction`/`Attempt` records, the same `FAILED`-when-provable / `ABANDONED`-after-timeout-otherwise split. A stuck Relay Dispatch transaction is reported plainly as unfixable by the engine — never implying the same recovery guarantee Managed Dispatch gives, since only the original signer could ever produce a valid replacement.

This is deliberately multi-chain from day one, even though only Solana is implemented first (EVM later): the orchestration logic is written once, chain-agnostically, against the Chain Handler interface's already-opaque `broadcast`/`getStatus` methods. Adding a chain means building its own Chain Handler — exactly how Solana's was built — never touching Relay Dispatch's own logic.

## User Stories

1. As an application whose end users bring their own wallets, I want to hand the engine an already-signed transaction and have it reliably delivered, so that I don't have to build my own broadcast-and-retry infrastructure.
2. As that same application, I want the engine to never ask for or need a private key, so that my users' funds are never in the engine's custody.
3. As an integrator, I want Relay Dispatch on the same `POST /v1/dispatch` endpoint I already call for Managed Dispatch, so that I have one integration surface to learn and version, not two.
4. As an integrator who has never heard of Relay Dispatch, I want my existing Managed Dispatch requests to keep working unchanged, so that this new mode never becomes a breaking change I have to react to.
5. As an integrator, I want a malformed or garbage signed transaction rejected immediately with a clear error, so that I find out at submission time, not by polling a status endpoint later.
6. As an integrator, I want the same `Idempotency-Key` requirement Managed Dispatch already has, so that a network retry on my end never creates a duplicate submission.
7. As an integrator, I want `GET /v1/dispatch/:id` to tell me unambiguously whether I'm looking at a Managed or Relay Dispatch, so that I never have to remember which mode I used to interpret the response correctly.
8. As an integrator, I want a Relay Dispatch's status response shaped honestly for what it actually is — one transaction, not a batch — so that I'm never parsing a fake single-item array.
9. As an integrator, I want a transient delivery failure (a dropped RPC call, a momentary network blip) retried automatically with my exact signed bytes, so that a flaky moment on the network doesn't require me to resubmit.
10. As an integrator, I want to know my transaction will never be silently fee-bumped or altered by the engine, so that nothing about it can execute differently than what I signed.
11. As an integrator, I want a transaction that can be *proven* dead (Solana's expired-blockhash case) to resolve to a clean, definitive failure, so that I know immediately I need to have my user re-sign.
12. As an integrator, I want a transaction that *can't* be proven dead to eventually stop being watched rather than hang forever, while still being told honestly that the engine gave up without a definitive answer.
13. As an integrator, I want confirmation tracking to work identically to Managed Dispatch's, so that my polling logic doesn't need mode-specific branches.
14. As a contributor, I want Relay Dispatch's orchestration code to hold zero chain-specific logic, so that supporting a new chain never means touching this feature's own code.
15. As a contributor, I want Relay Dispatch to reuse the existing `Transaction`/`Attempt` records and the existing `Coordinator` poll loop completely unchanged, so that this feature doesn't duplicate machinery that's already correct.
16. As a contributor, I want a real, symmetric validation method on the `ChainHandler` interface (`validateSignedTransaction`, alongside the existing `validateCall`) enforced by the shared conformance suite, so that every current and future chain implementation is held to the same standard, not just Solana's.
17. As a contributor, I want a resubmission of identical signed bytes recorded as a new Attempt of the same Transaction, never a new Transaction row, so that the domain model stays honest about what actually changed on-chain (nothing).
18. As a maintainer, I want Relay Dispatch's domain representation to be its own type, not a forced variant of `Dispatch`, so that nothing downstream ever has to special-case a batch structure that's always exactly one item.
19. As a maintainer, I want the Chain Handler interface change this feature needs reviewed on its own, separately from Relay Dispatch's own issues, so that a change to shared, every-chain-implements-it infrastructure gets the scrutiny that scope deserves.
20. As an operator, I want Relay Dispatch to never touch the Funding Check, so that submitting a relayed transaction never triggers an RPC balance call against a wallet the engine doesn't even control.

## Implementation Decisions

- **Wire format**: `POST /v1/dispatch` gains an optional `mode: "managed" | "relay"` field, defaulting to `"managed"`. A `mode: "relay"` body is `{ chain, signedTransaction }` — no `items`, no `retryPolicy`. `Idempotency-Key` is still required (ADR-0021) and still means create-once: resubmitting the same key returns the original Relay Dispatch's current state.
- **Domain type**: a new, deliberately small `RelayDispatch { id, chain, idempotencyKey, signedTransaction, status, transactionId }` — never a `Dispatch`/`DispatchItem` variant, since a Relay Dispatch is always exactly one already-signed transaction, never a batch to aggregate. `signedTransaction` is the same opaque `SignedTransaction` string type `ChainHandler.broadcast` already consumes (ADR-0027's opacity discipline unchanged). Once broadcast, `transactionId` points at an ordinary `Transaction` row, reused completely unchanged.
- **`GET /v1/dispatch/:id` response for a Relay Dispatch**: `{ dispatchId, mode: "relay", status, transactionHash, error }` — an honestly distinct shape, not a fake one-item version of Managed Dispatch's `items` array. Every response (both modes) includes `mode` so a caller can tell which they're looking at from the body alone.
- **Repository**: `DispatchStore` grows create/get/claim-queued methods for `RelayDispatch`, backed by its own table — never the `dispatches` table, which has no meaningful `items`/`retryPolicy` for this shape. Both `InMemoryDispatchStore` and `PostgresDispatchStore` implement it (ADR-0011).
- **Coordinator**: new methods on the existing `Coordinator` class (not a separate class — it already holds the deps this needs). `processQueuedRelayDispatches` claims queued rows and calls `handler.broadcast(signedTransaction)` once, with a small bounded retry (about 3 attempts, backoff) of the identical bytes on a transient send failure, using the already-existing `DispatchStore.recordBroadcast` to record each resend as a new Attempt of the same Transaction (CONTEXT.md's Attempt-vs-Transaction distinction) — never a new Transaction row. `Coordinator.pollPendingTransactions` is reused completely unchanged for confirmation tracking; it already has no awareness of `Dispatch`, `Payment`, or `Call`.
- **Terminal state**: reuses the existing `TransactionStatus` set as-is — no new status. A chain that can prove a transaction is dead (Solana, via the blockhash-expiry mechanism already established for Managed Dispatch, ADR-0030) resolves to `FAILED`; a chain that can't falls back to the Coordinator's existing generic `ABANDONED`-after-timeout path. This is the same split Managed Dispatch already has, applied unchanged.
- **`ChainHandler` interface change** (scoped as its own `core-engine-scaffold` issue, not this feature's — see Further Notes): a new `validateSignedTransaction(signed): Promise<Result<void, DispatchError>>` method, cheap and RPC-free, symmetric to the existing `validateCall`. The API route calls it before ever persisting a `RelayDispatch`; a failure returns `400` synchronously. Enforced by the shared conformance suite for every Chain Handler, present and future (ADR-0015).
- **Solana-specific bookkeeping fix**: `SolanaChainHandler.broadcast`'s retry-on-expiry and `getStatus`'s provable-`FAILED` decision both depend on a blockhash cache populated only when this handler itself signs a transaction. Since a Relay Dispatch transaction is never signed by it, `broadcast` is extended to derive that same bookkeeping by decoding the blockhash directly out of the caller-supplied signed bytes — no RPC needed, since a transaction's blockhash is embedded in its own bytes.
- **Multi-chain extensibility**: no new `ChainHandler` methods beyond `validateSignedTransaction` are needed for this. `broadcast`/`getStatus` are already opaque-string-in/opaque-string-out with no Managed-Dispatch-specific coupling — Relay Dispatch's orchestration code calls them exactly as Managed Dispatch's `Coordinator` already does, via the same `ChainRegistry`.

## Testing Decisions

Two-tier discipline unchanged (ADR-0013): fast pure-unit tests for chain-agnostic orchestration, real devnet RPC for actual chain behavior — no fake Chain Handler stands in for real broadcast/confirmation logic anywhere.

- **Primary seam, one level, reused from Managed Dispatch's own precedent**: the real HTTP API (`app.inject()` on `POST /v1/dispatch` and `GET /v1/dispatch/:id`) driving a real `Coordinator` against a real in-memory `DispatchStore` and the real `SolanaChainHandler` on real devnet — exactly `dispatch-api-e2e.test.ts`'s own shape, extended to the relay mode. Covers: a transaction signed entirely outside the engine, submitted, confirmed, and independently verified on-chain; a malformed submission rejected with `400` and never persisted; mode defaulting when the field is omitted.
- **Coordinator orchestration logic** (bounded retry count, `recordBroadcast` called correctly, no-op reuse of `pollPendingTransactions`): tested against a fake `DispatchStore` and a configurable fake `ChainHandler`, the existing seam `coordinator.test.ts` already uses — no new seam.
- **`ChainHandler.validateSignedTransaction`**: covered by the shared conformance suite (a valid and an invalid signed-transaction fixture, mirroring the suite's existing `invalidSignedTransaction` broadcast-rejection case) plus `SolanaChainHandler`'s own real-devnet-adjacent unit tests (decode/verify is a pure local check, no RPC needed to test it — matches how `validateCall`'s own tests are structured).
- **The blockhash-bookkeeping fix**: real devnet, mirroring issues 06/08's own tests exactly, with the signature produced by a keypair entirely outside the handler under test — proving retry-on-expiry and the provable-`FAILED` path work identically for a transaction this handler never itself signed.

## Out of Scope

- Fee-bumping or any retry that changes the signed bytes — structurally impossible without the original key (ADR-0005).
- Multi-signature/M-of-N collection (a DAO treasury scenario raised earlier) — a real, separate extension, not part of this.
- Semantic or simulation-based validation beyond cheap shape/signature checks (`validateSignedTransaction`) — a transaction that's structurally valid but will fail on-chain for its own reasons still gets broadcast and fails there, exactly like a Managed Dispatch Call does.
- EVM's own Relay Dispatch implementation — the orchestration this spec describes is chain-agnostic by design, but building EVM's `ChainHandler` (and therefore EVM Relay Dispatch) is separate, later work.
- Webhooks — polling remains the baseline (ADR-0023), unchanged by this feature.

## Further Notes

Issues are written and ready: `.scratch/relay-dispatch/issues/01`–`04` (this feature's own, chain-agnostic orchestration), `core-engine-scaffold/issues/13` (the `ChainHandler` interface change — its own review cadence, since it touches shared infrastructure every chain implements, not scoped to this feature), and `solana-chain-handler/issues/14`–`16` (Solana's implementation of that interface method, the bookkeeping fix, and the real-devnet end-to-end proof, deliberately last and blocked on everything else landing first).

The ADR-0026 precondition — Solana's broadcast, blockhash-retry, and status-tracking landing for Managed Dispatch — is met; that's what unblocked writing these issues now rather than earlier. Three new ADRs (0031–0033) record the consequential decisions from this design pass: Relay Dispatch's wire/domain shape, the `ChainHandler` interface addition, and the blockhash-bookkeeping fix's revision of the implicit self-signed-only assumption in issues 05–08.
