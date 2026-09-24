Status: ready-for-agent

# ChainHandler.validateSignedTransaction

Adds one new method to the `ChainHandler` interface (`src/chain-handler/chain-handler.ts`): `validateSignedTransaction(signed: SignedTransaction): Promise<Result<void, DispatchError>>` — cheap shape/signature validation only, never an RPC round-trip, symmetric to the existing `validateCall`. Surfaced by `relay-dispatch` issue 03: a Relay Dispatch submission arrives already signed by someone else, and rejecting an obviously-malformed one at submission time (400, nothing persisted) is worth a real check rather than letting it sit as a queued row that only fails later at broadcast.

Every `ChainHandler` implementation must add it, and the shared conformance suite (`src/chain-handler/conformance.ts`, ADR-0015's extendibility discipline) must grow a case for it — a malformed signed transaction fixture (mirroring the existing `invalidSignedTransaction` fixture already used for the `broadcast` rejection test) that `validateSignedTransaction` is expected to reject, and a validly-signed one it's expected to accept. `StubChainHandler` needs a trivial implementation purely so the conformance suite and existing tests keep passing, matching how it already treats every other method (ADR-0028's precedent for `paymentToCall`).

This is a shared-interface change — one issue at a time, reviewed before the next, per this repo's own review cadence for `core-engine-scaffold` work. `relay-dispatch` issue 03 and `solana-chain-handler`'s own implementation of this method are both blocked on it landing first.
