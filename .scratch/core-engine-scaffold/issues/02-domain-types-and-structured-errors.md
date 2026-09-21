Status: ready-for-agent

# Domain types and structured errors

Define the core domain types: `Dispatch`, `Payment` (or the Managed-Dispatch equivalent — a single line item to send), `Transaction`, `Attempt` (CONTEXT.md), and the transaction status set including `ABANDONED` as distinct from `FAILED` (ADR-0004). Define the structured error shape from ADR-0010: `{ code, message, chainDetail? }`, with an initial `code` union covering at least `INSUFFICIENT_FUNDS`, `INVALID_RECIPIENT`, `SIGNER_UNREACHABLE`, `CHAIN_REJECTED`, `RPC_UNAVAILABLE`. Expected outcomes (anything a caller needs to branch on) are typed return values, not thrown exceptions (ADR-0010/Q22) — pick and document one discriminated-union convention now (e.g. a `Result<T, DispatchError>` type) since every later module's interface depends on this shape.

This is pure types + the `Result` helper — no I/O, no persistence, no chain code.
