# A pre-flight Funding Check runs before a batch is attempted

Without it, a batch against an underfunded Sender would discover that fact one `Call` at a time — potentially hundreds of individually-failed nonce assignments and RPC round-trips before the caller learns anything useful. Instead, the Coordinator aggregates the required amount per asset across a claimed batch and checks it against the Sender's real balance (via the Chain Handler's `getBalance`) before any Execution Plan is formed — matching the old repo's placement (ADR-0012 there): this happens in the Coordinator's claim step, never on the `POST /v1/dispatch` ingest path, so a Dispatch submission never pays for a balance RPC call it doesn't need yet.

A shortfall fails the affected `Call`s immediately with a structured `INSUFFICIENT_FUNDS` error whose `chainDetail` names exactly which asset and how much more is needed — not a generic failure.

## Consequences

This is the simple version: no Prefunded/Reactive funding-mode distinction (the old repo's ADR-0012 had both, with Reactive auto-resuming once topped up). That distinction is not built now — if "wait and auto-resume once funded" turns out to be wanted, it's a mode added later on top of this same check, not a redesign of it.
