Status: needs-triage

# Document the Coordinator's ChainHandler test-double convention

spec.md's Testing Decisions section names "a trivial stub Chain Handler" (i.e. issue 05's `StubChainHandler`) as what the Coordinator's unit tests should run against. In practice, `coordinator.test.ts` uses a hand-rolled `FakeChainHandler` (built with `vi.fn()` per method, defaulting to success, overridable per test) instead — `StubChainHandler` is fixed/no-op and can't produce most of the branches the Coordinator's orchestration logic needs exercised (a `prepare`/`sign` failure, a `FAILED` on-chain status, an RPC error from `getStatus`).

The in-file comment on `FakeChainHandler` explains this reasoning, but the deviation from spec.md's stated testing approach was never reflected back into the spec or an ADR — surfaced during issue 06's code review (2026-09-22).

Resolve by either:
- Updating spec.md's Testing Decisions section to describe the actual convention (a configurable per-method fake for orchestration branch coverage, distinct from the fixed conformance-suite stub) — this would also then govern `solana-chain-handler`'s own future Coordinator-adjacent tests, if any, and any later scaffold issue (09's Funding Check) that needs the same kind of branch coverage.
- Or deciding `StubChainHandler` should itself grow configurability (setter methods / constructor options for each return value) so one Chain Handler double serves both roles — weigh this against issue 05's own framing of `StubChainHandler` as deliberately trivial/no-op, since making it configurable blurs that line.

Low priority — this is a documentation/consistency gap, not a functional one; the current tests are correct and the reasoning is sound, just not written back into the process the repo asks for.
