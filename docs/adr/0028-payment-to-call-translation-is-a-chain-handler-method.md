---
status: accepted — amends ADR-0018's "API layer translates Payment to Call"
---

# Payment→Call translation is a Chain Handler method, not API-layer logic

ADR-0018 and CONTEXT.md's `Payment` entry both say the API layer translates a `Payment` into a `Call` "(a native transfer or a known token-transfer encoding) before it ever reaches a Chain Handler" — true of *when* it happens, but silent on *how*, and building issue 08 (`core-engine-scaffold`'s API routes) surfaced that the "how" isn't API-layer logic at all: encoding a native SOL transfer or an SPL token transfer (or an ERC-20 `transfer` call on EVM) is exactly the same kind of real, chain-specific mechanical knowledge a Chain Handler's `prepare()` already owns — it's what `solana-chain-handler` issues 02/03 (`account-resolution`, `native-sol-transfer`, `spl-token-transfer`) exist to build. The API layer has no legitimate way to construct a valid, chain-specific `Call` from a `Payment` on its own without either duplicating that knowledge or getting it wrong.

`ChainHandler` (issue 05) gains `paymentToCall(payment): Promise<Result<Call, DispatchError>>`. The API route still does the *translating* — it calls this method on whichever Chain Handler is registered (via the chain registry, issue 07) for the Dispatch's chain — but the actual encoding knowledge lives exactly where every other piece of chain-specific mechanics already lives.

## Consequences

Issue 08 ends up depending on issue 05 (the interface) and issue 07 (the registry, to look up the right handler) even though its own "blocked-by" line only names issues 02/03 — that line was written before issue 05/07 existed as separately-built pieces. `StubChainHandler` (issue 05) needs a trivial `paymentToCall` implementation purely so the conformance suite and Coordinator/API tests keep working; it produces no meaningful encoding, matching its existing "trivial, no-op" framing. Real Payment→Call encoding for a real chain remains entirely `solana-chain-handler`'s (and any future EVM feature's) own scope — this ADR only fixes *where* the seam lives, not what crosses it for any real chain.

This is a narrow exception to ADR-0009's "the API's job is limited to validating and writing a Dispatch's rows; all chain interaction happens in the worker's poll loop": `paymentToCall` is the one Chain Handler method the API route calls directly. It's a pure, non-broadcasting translation (no RPC, no state change, no key material) — everything else (`validateCall`, `prepare`, `sign`, `broadcast`, `getStatus`, `getBalance`) still belongs exclusively to the Coordinator's worker-side poll loop.
