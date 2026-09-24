# ChainHandler gains `validateSignedTransaction`, symmetric to `validateCall`

Relay Dispatch (ADR-0005, ADR-0026) accepts an already-signed transaction from a caller the engine has never interacted with before. Without any check, a malformed or garbage submission would be persisted as a queued row and only discovered as broken when the worker eventually got to it and called `broadcast` — real space taken up by requests that were never going to succeed, and a slower, worse failure signal for the caller than a synchronous rejection would give.

The Chain Handler interface (core-engine-scaffold issue 05) already has exactly this shape of check on the *building* side — `validateCall` does cheap, RPC-free shape validation on an unsigned Call before `prepare` ever touches it. `validateSignedTransaction(signed): Promise<Result<void, DispatchError>>` is the same discipline applied to the *receiving* side: decode the opaque signed-transaction string and confirm it actually is one (a real signature present and cryptographically valid, a fee payer set) — never an RPC round-trip, never semantic or simulation-based understanding of what it does. A structurally valid transaction that will fail on-chain for its own reasons still gets broadcast and fails there, exactly like a Managed Dispatch Call does.

Every `ChainHandler` implementation, current and future, must add it, and the shared conformance suite (ADR-0015) grows a case enforcing it — a valid and an invalid signed-transaction fixture, mirroring the suite's existing `invalidSignedTransaction` broadcast-rejection case. `StubChainHandler` gets a trivial implementation purely so the suite and existing tests keep passing, matching how it already treats every other method.

## Consequences

This is a shared-interface change, scoped to its own `core-engine-scaffold` issue (13) rather than folded into `relay-dispatch`'s own issues — it touches infrastructure every chain implements, and this repo's own review cadence treats a change to the Chain Handler interface as warranting its own focused review, one issue at a time, separate from any feature that happens to be the reason it's needed.
