Status: ready-for-agent

# 13: ChainHandler gains validateSignedTransaction

**What to build:** Any Chain Handler — including the trivial stub — can be asked whether a given already-signed transaction is well-formed, without ever touching the network to answer, and the shared conformance suite holds every implementation, current and future, to that same standard. Surfaced by `relay-dispatch`: a Relay Dispatch submission arrives already signed by someone else, and rejecting an obviously-malformed one at submission time is worth a real check rather than letting it sit as a queued row that only fails later at broadcast.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `ChainHandler` interface gains `validateSignedTransaction(signed: SignedTransaction): Promise<Result<void, DispatchError>>`, symmetric to the existing `validateCall`
- [ ] Never performs an RPC round-trip
- [ ] `StubChainHandler` implements it trivially, matching how it already treats every other method
- [ ] The shared conformance suite grows a case for it — a valid and an invalid signed-transaction fixture, mirroring the suite's existing `invalidSignedTransaction` broadcast-rejection case
- [ ] Existing tests, typecheck, and lint all still pass
