/**
 * core-engine-scaffold issue 15: a shared client-side deadline for every
 * outbound network call this engine makes — Solana RPC via `Connection`,
 * and the Signer over HTTP. Nothing enforced one before, so a stuck call
 * left a worker `tick()` awaiting forever, and `shutdown()` (SIGINT/
 * SIGTERM) couldn't return until it did. `AbortSignal.timeout` actually
 * cancels the underlying request rather than just abandoning it, so a
 * timed-out call never keeps running — and possibly still mutating state —
 * after its caller has moved on to the next tick.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 15_000;

/** Wraps a fetch-compatible function so every request it makes is aborted, not merely abandoned, past `timeoutMs`. */
export function fetchWithTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
