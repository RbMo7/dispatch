# Bulk Call uses a caller-named aggregator, and reads per-item outcomes from a trace

Bulk Call (ADR-0006, #11) sends a request's items as `aggregate3Value(Call3Value[])` transactions, with every item marked `allowFailure: true`. Four things about how it works were not obvious, and each shaped the design.

## The aggregator

Inside `aggregate3Value`, the `msg.sender` of every sub-call is the **aggregator**, not the Sender. The consequences:

- **ERC-20 items transfer from the aggregator's own balance.** A `transfer` moves the aggregator's tokens.
- **The canonical Multicall3 (`0xcA11…CA11`) is permissionless.** Anyone can call it, so approving it for `transferFrom` lets anyone drain the approval.

So the request always names its own aggregator in `bulkCall: { aggregator, maxBatchSize? }`, and the engine never assumes, deploys or owns one. The API rejects with `400` any ERC-20 item sent to the canonical address, because that combination can only fail or lose funds. It also rejects `bulkCall` on chains without Bulk Call (Solana bundles natively), on Relay Dispatch, and when no trace RPC is configured.

## Per-item outcomes

A receipt carries no return data, and Multicall3 emits no per-call events. So `Result[]` can only be seen by tracing the transaction. A new optional handler method, `getBundleStatus(hash)`, runs `debug_traceTransaction` with `callTracer` against `config.base.traceRpcUrl` and returns one status per slot:

- **Top-level revert:** every member is `FAILED`.
- **Top-level success:** each member gets its own slot's outcome.
- **Trace unavailable:** members stay `PENDING`.

A member's slot is its rank by `callIndex` among the rows sharing the chunk's hash. That holds because chunks never span Dispatches and `prepare` keeps the order it is given. The public Base Sepolia RPC and Alchemy's free tier both refuse tracing, so Bulk Call is only enabled when a tracing RPC is configured.

## Submission

`prepare` gains an optional third parameter, `options?: { bulkCall }`. The Coordinator calls `prepare` once per Bulk Dispatch. Base splits the items into chunks of `maxBatchSize`, encodes each chunk with its own nonce, and returns the same `unsignedTransaction` for every item in a chunk. The Coordinator's existing byte-identical grouping then broadcasts once per chunk, with one row per member. Fee-bumps (ADR-0037) and the reorg safety net (ADR-0036) work per hash and need no changes.

A separate optional handler method, `validateBulkCall`, is both the capability signal and the request check, so the API layer stays chain-agnostic.

## Funding

Native amounts and gas are checked against the Sender. Bulk ERC-20 amounts are checked against the aggregator's balance. A shortfall fails those items up front, naming the aggregator (ADR-0024).

## Consequences

- **Interface growth.** The ChainHandler interface gains two optional methods and one optional parameter. None of them affect a chain that doesn't implement Bulk Call (ADR-0015 scrutiny, same pattern as ADR-0037).
- **Tracing RPC required.** Bulk Call needs a tracing-capable RPC, which is usually a paid tier.
- **Nonce gap.** A failed chunk broadcast leaves a nonce gap that strands the later chunks. The default one-transaction-per-payment mode has the same problem, tracked in #24.

## Amendment (2026-09-26): `allowFailure` is per request, and defaults to `false`

Per-item failures are rare for plain payouts to ordinary wallets. When they do happen, it's around contract recipients, blacklisted or paused tokens, and callers' own raw calls. Isolating them is what needs a tracing RPC, which is usually a paid tier. So `bulkCall.allowFailure` is now a request choice:

- **`false` (the default):** every item is encoded `allowFailure: false`. Any failing item reverts its whole chunk, and every item in that chunk is reported `FAILED` from the receipt alone. The Coordinator uses plain `getStatus`, nothing is traced, and no tracing RPC is needed.
- **`true`:** as originally decided above. Each item succeeds or fails on its own, read from `Result[]` in a trace, and a tracing RPC is required. Without one, the request gets `400`.

The default follows ADR-0003's spirit for newcomers: a batch either lands whole or visibly fails whole, never silently partial. The cost is that one bad item takes its chunk-mates down and they must be resubmitted. That reverses user story 7's "one bad payment fails on its own" as the *default*; it remains available by opting in.
