Status: resolved

# worker.ts's tick has no timeout — a hung RPC call blocks shutdown indefinitely

Found during issue 12's code review (2026-09-24), not a functional bug in normal operation — `worker.ts`'s per-tick `try/catch` only protects against a *rejection* (`processQueuedDispatches`/`processQueuedRelayDispatches`/`pollPendingTransactions` throwing or returning a rejected promise). It does nothing if a `ChainHandler` call inside one of those (`broadcast`, `getStatus`, `sign`, ...) simply never resolves — there's no client-side RPC timeout anywhere in `SolanaChainHandler` or the `Connection`/`SignerClient` it wraps.

If that happens, `shutdown()` (SIGINT/SIGTERM) sets `running = false`, but the worker's `while` loop is still `await`ing the in-flight `tick()` — so the process hangs past the signal until an operator sends `SIGKILL`, rather than exiting on its own once the current tick finishes (the graceful-shutdown behavior the loop is otherwise designed to give).

Needs a design decision before implementation:

- A timeout wrapper around each Coordinator call in `tick()` (e.g. `Promise.race` against a deadline), with the timed-out attempt logged and left for the next tick to retry?
- Or timeout support pushed down into `SolanaChainHandler`/`Connection` itself, so a hung RPC call surfaces as a structured `RPC_UNAVAILABLE` `DispatchError` the normal way, rather than the worker loop needing to know about it at all?
- Either way: what's a reasonable deadline, and should `shutdown()` also start a fallback force-exit timer (e.g. `setTimeout(() => process.exit(1), N)`) as a last resort regardless of which fix lands?

## Comments

Resolved 2026-09-24: pushed the timeout into the RPC/Signer boundary rather than wrapping calls in worker.ts. Reasoning: a `Promise.race` in `tick()` only stops the worker from *awaiting* a hung call — the underlying request keeps running in the background with no way to cancel it, which risks a real race (the next tick starts a fresh attempt while the orphaned old one might still resolve and write conflicting state). Aborting the actual network call avoids that.

- New `src/rpc-timeout.ts`: `fetchWithTimeout(fetchImpl, timeoutMs)` wraps a fetch-compatible function with `AbortSignal.timeout(timeoutMs)`, actually cancelling the request, not just abandoning it. `DEFAULT_RPC_TIMEOUT_MS = 15_000`.
- `config.ts`: new `rpcTimeoutMs` (`RPC_TIMEOUT_MS` env var, defaults to 15s).
- `chain-loaders.ts`: the Solana `Connection` is constructed with `fetch: fetchWithTimeout(fetch, config.rpcTimeoutMs)` — every RPC call it makes (blockhash fetch, `sendRawTransaction`, `getSignatureStatuses`, `isBlockhashValid`, `getBalance`, …) inherits the deadline for free, no per-call-site changes needed. A timeout throws with "timeout" in its message, which `error-mapping.ts`'s existing `isRateLimitOrTimeout` pattern already classifies as `RPC_UNAVAILABLE` — no changes needed there.
- `signer/client.ts`: `SignerClient` takes an optional `timeoutMs` constructor param (defaults to `DEFAULT_RPC_TIMEOUT_MS`) and passes `AbortSignal.timeout(this.timeoutMs)` on its own `fetch` call; a timeout is caught by the existing catch block and mapped to `SIGNER_UNREACHABLE`, same as any other unreachable-signer failure.
- `worker.ts`: `shutdown()` also starts a 30s force-exit fallback timer (`SHUTDOWN_FORCE_EXIT_MS`), documented as a last-resort guard in case some future call path is ever added without going through the shared timeout.
- Tests: `src/rpc-timeout.test.ts` (new), existing `signer/client.test.ts` and `coordinator.test.ts` still pass (40/40).
