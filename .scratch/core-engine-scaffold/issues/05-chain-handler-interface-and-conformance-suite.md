Status: ready-for-agent

# Chain Handler interface and conformance test suite

Define the Chain Handler interface (CONTEXT.md): build an unsigned transaction from a set of payments, broadcast a signed one, check a transaction's status. Keep the unsigned/signed transaction payload opaque to everything outside the Chain Handler that produced it (matching the reference implementation's `unsignedTransaction: unknown` pattern) — the interface must not assume anything EVM- or Solana-shaped.

Then build the conformance test suite from ADR-0015: an exported set of behavioral tests, written against the interface only, that any Chain Handler must pass — e.g. `validatePayment` rejects a malformed recipient, `getStatus` never returns `CONFIRMED` before broadcast, a Chain Handler never mutates the payments array it's given, a broadcast failure surfaces a structured error (ADR-0010) rather than throwing an untyped exception. Prove the harness itself works by running it against a trivial, no-op stub implementation (not a real chain) — that stub is only for proving the suite runs, not for testing real chain behavior (ADR-0013 still governs how a real Chain Handler, starting with Solana, gets tested).
