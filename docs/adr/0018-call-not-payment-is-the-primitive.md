# Call, not Payment, is the primitive a Chain Handler consumes

Managed Dispatch was scoped around "payments" (recipient/asset/amount), but a real use case surfaced immediately: an application with its own smart contract (e.g. a token-assignment call to a beneficiary) needs the engine to submit an arbitrary, already-application-encoded contract call — not a plain transfer. Rather than bolt contract calls on as a special case later, the underlying primitive is `Call` (EVM: `{to, data, value}`; Solana: `{programId, accounts, data}`) — opaque to the engine, encoded entirely by the caller's own application, which already owns the ABI/IDL. `Payment` becomes a convenience shape the API layer translates into a `Call` (a native transfer or a known token-transfer encoding) before anything reaches a Chain Handler. Every Payment is a Call; not every Call is a Payment.

## Consequences

A Chain Handler's `prepare()` only ever sees `Call` — never a special code path for "this one came from a Payment." Nonce sequencing, batching, Retry Policy, and `ABANDONED` handling apply identically regardless of which shape a line item started as, since none of that logic ever needed to look inside the call's data in the first place.
