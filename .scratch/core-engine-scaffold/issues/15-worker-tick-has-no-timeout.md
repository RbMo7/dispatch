Status: needs-triage

# worker.ts's tick has no timeout — a hung RPC call blocks shutdown indefinitely

Found during issue 12's code review (2026-09-24), not a functional bug in normal operation — `worker.ts`'s per-tick `try/catch` only protects against a *rejection* (`processQueuedDispatches`/`processQueuedRelayDispatches`/`pollPendingTransactions` throwing or returning a rejected promise). It does nothing if a `ChainHandler` call inside one of those (`broadcast`, `getStatus`, `sign`, ...) simply never resolves — there's no client-side RPC timeout anywhere in `SolanaChainHandler` or the `Connection`/`SignerClient` it wraps.

If that happens, `shutdown()` (SIGINT/SIGTERM) sets `running = false`, but the worker's `while` loop is still `await`ing the in-flight `tick()` — so the process hangs past the signal until an operator sends `SIGKILL`, rather than exiting on its own once the current tick finishes (the graceful-shutdown behavior the loop is otherwise designed to give).

Needs a design decision before implementation:

- A timeout wrapper around each Coordinator call in `tick()` (e.g. `Promise.race` against a deadline), with the timed-out attempt logged and left for the next tick to retry?
- Or timeout support pushed down into `SolanaChainHandler`/`Connection` itself, so a hung RPC call surfaces as a structured `RPC_UNAVAILABLE` `DispatchError` the normal way, rather than the worker loop needing to know about it at all?
- Either way: what's a reasonable deadline, and should `shutdown()` also start a fallback force-exit timer (e.g. `setTimeout(() => process.exit(1), N)`) as a last resort regardless of which fix lands?
