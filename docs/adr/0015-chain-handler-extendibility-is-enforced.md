# Chain Handler extendibility is an enforced rule, not just an intention

Adding a chain must never require changing the Coordinator, the Signer contract, or another Chain Handler — this was an informal comment in the reference implementation ("implement it, register it, nothing else changes"); here it's an enforced discipline. It's enforced two ways: (1) a shared conformance test suite, exported from the engine core and run against every Chain Handler (current and future), that exercises the contract's invariants (rejects an invalid recipient, returns `PENDING` before confirmation, never mutates its input, surfaces a structured error per ADR-0010 rather than swallowing one); and (2) code review treats any change to the Coordinator or the Chain Handler interface itself, made in service of adding a chain, as a signal the interface is wrong — not something to special-case around.

## Consequences

This is what makes "extendible" checkable for an open-source project rather than aspirational: a contributor's new Chain Handler can be trusted by passing the conformance suite, without a maintainer re-auditing its internals by hand.
