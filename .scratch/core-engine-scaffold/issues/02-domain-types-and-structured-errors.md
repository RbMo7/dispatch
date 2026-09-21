Status: ready-for-agent

# Domain types and structured errors

Define the core domain types: `Dispatch`, `Transaction`, `Attempt` (CONTEXT.md), and the transaction status set including `ABANDONED` as distinct from `FAILED` (ADR-0004). Define the structured error shape from ADR-0010: `{ code, message, chainDetail? }`, with an initial `code` union covering at least `INSUFFICIENT_FUNDS`, `INVALID_RECIPIENT`, `SIGNER_UNREACHABLE`, `CHAIN_REJECTED`, `RPC_UNAVAILABLE`. Expected outcomes (anything a caller needs to branch on) are typed return values, not thrown exceptions (ADR-0010/Q22) — pick and document one discriminated-union convention now (e.g. a `Result<T, DispatchError>` type) since every later module's interface depends on this shape.

A Dispatch's line items are `Call`, not `Payment` — see ADR-0018. Define `Call` as the primitive the Chain Handler interface actually consumes (EVM: `{to, data, value}`; Solana: `{programId, accounts, data}`), and `Payment` (`recipient`/`asset`/`amount`) as a convenience shape the API layer translates into a `Call` before it ever reaches a Chain Handler. A Chain Handler's `prepare()` should only ever need to know about `Call` — it must not need a special code path for "this one came from a Payment."

This is pure types + the `Result` helper — no I/O, no persistence, no chain code.
