Status: ready-for-agent

# Core engine scaffold

## Problem Statement

A developer or operator wants to run a chain-agnostic transaction dispatch engine — one that accepts a batch of payments or contract calls over a simple API and handles nonce sequencing, batching, retries, and confirmation tracking without them having to understand any chain's execution model. None of that exists yet: there is no API to call, no worker to process anything, no place for a Chain Handler to plug into, and no persisted state to recover from a restart. Nothing chain-specific (Solana first, per `.scratch/solana-chain-handler/`) can be built until this exists.

## Solution

A minimal, chain-agnostic engine core: an API process and a separate worker process (ADR-0009) sharing Postgres as an outbox. The API accepts a Dispatch (a batch of `Call`/`Payment` line items, ADR-0018) behind a required Idempotency Key (ADR-0021) and a single operator-configured bearer token (ADR-0022), and returns immediately; the worker's Coordinator claims queued work, runs a pre-flight Funding Check (ADR-0024), calls the appropriate Chain Handler (selected by config, ADR-0019, never hardcoded), applies Retry Policy (off by default, ADR-0003) and the chain-aware `ABANDONED`/`FAILED` distinction (ADR-0004), and persists every state transition. No real Chain Handler is built here — only the interface, its conformance suite, and a trivial stub to prove the seam works.

## User Stories

1. As an integrating developer, I want every expected failure (insufficient funds, invalid recipient, chain rejection) returned as a structured error with a stable code, so that I can branch on it programmatically instead of parsing a message string.
2. As an integrating developer, I want a failure's chain-specific detail preserved in a `chainDetail` field, so that I can see the real underlying cause instead of a generic bucket.
3. As a contributor, I want one documented `Result`-style convention used across every module's interface, so that I never have to guess whether a given function throws or returns.
4. As an integrating developer, I want a Dispatch's line items to be `Call`, with `Payment` as a convenience shape, so that I can send either a plain transfer or an arbitrary application-defined contract call through the same request.
5. As an integrating developer, I want `ABANDONED` distinguished from `FAILED` in the status vocabulary, so that I never mistake "the engine stopped watching" for "the chain rejected it" and risk double-paying a recipient.
6. As a contributor, I want the Coordinator's persistence needs exposed through a small, domain-shaped repository interface, so that I can test orchestration logic against a fake instead of a real database.
7. As an operator, I want every Dispatch/Call/Transaction/Attempt persisted in Postgres, so that a crash or restart never loses in-flight state.
8. As a contributor, I want an in-memory fake implementing the same repository interface, so that Coordinator and route tests run fast and deterministically.
9. As an operator, I want the engine to hold no private key material and no signing-vendor SDK in its own dependency tree, so that a bug in the engine's complex batching/retry code can never leak into a key.
10. As an operator, I want a trivial reference Signer bundled into `docker-compose`, so that I can run the whole engine end to end on one command without standing up my own KMS first.
11. As an operator, I want to point the engine at my own production Signer by changing one configured URL, so that I never modify or redeploy the engine itself to change how signing happens.
12. As a contributor, I want a documented Chain Handler interface (validate, prepare, sign-request, broadcast, getStatus, getBalance) that never assumes any specific chain's transaction shape, so that adding a new chain family never requires changing this interface.
13. As a contributor, I want a shared conformance test suite I can run against a new Chain Handler, so that I know it's correctly implemented without a maintainer manually auditing my code.
14. As a maintainer, I want the conformance suite to catch a Chain Handler that mutates its input, swallows an error, or reports `CONFIRMED` before broadcast, so that a subtle bug never reaches production undetected.
15. As an operator, I want the Coordinator to hold zero chain-specific logic, so that every chain's quirks stay contained in its own Chain Handler.
16. As an integrating developer, I want Retry Policy off by default, so that the engine never spends more of my funds than I explicitly authorized.
17. As an integrating developer, I want to opt into Retry Policy per Dispatch, with a global operator default, so that I can choose urgency/cost tolerance per batch rather than being locked into one global behavior.
18. As an integrating developer, I want a stuck EVM-style transaction marked `ABANDONED` rather than `FAILED` after a chain-aware timeout, so that I never safely resend a payment that might still land and accidentally double-pay a recipient.
19. As an integrating developer, I want an `ABANDONED` transaction still watched at low frequency for a bounded window, so that I find out if it confirms after all.
20. As an operator, I want to enable only the chains I actually need via a single config value, so that chains I don't use never open an RPC connection or start a polling loop.
21. As an integrating developer, I want a request naming a chain that isn't enabled to fail with a clear `CHAIN_NOT_ENABLED` error, so that I immediately know it's a configuration issue, not a bug.
22. As an integrating developer, I want to submit a batch of Calls/Payments in one `POST /v1/dispatch` request, so that I don't have to make one request per payment.
23. As an integrating developer, I want a required `Idempotency-Key` on every Dispatch, so that retrying a timed-out request never creates a duplicate disbursement.
24. As an integrating developer, I want resubmitting the same `Idempotency-Key` to return my original Dispatch's current state, so that a retry is always safe.
25. As an operator, I want every request authenticated with a single configured bearer token, so that I don't need a multi-tenant key-management system I have no use for.
26. As an integrating developer, I want to poll `GET /v1/dispatch/:id` for status, so that I can build my own UI/logic around a batch's progress without needing webhooks yet.
27. As an integrating developer, I want a batch the Sender can't afford to fail immediately, naming exactly which asset and how much more is needed, so that I don't wait for hundreds of individual failures to learn the wallet is empty.
28. As an operator, I want the funding check to run in the Coordinator's claim step, not on the request-submission path, so that submitting a Dispatch never pays for a balance RPC call it might not need.
29. As an operator, I want `docker-compose up` to bring up the API, the worker, Postgres, and a reference Signer together, so that local setup is one command, not several manually-ordered steps.
30. As a contributor, I want the API and worker as separate processes sharing the same database, so that a worker crash never takes down the request-accepting API.
31. As a contributor, I want adding a new chain to never require changing the Coordinator, the Signer contract, or another Chain Handler, so that the codebase doesn't get riskier to touch as more chains are added.
32. As a maintainer, I want each Chain Handler activatable independently via config, so that a fork or deployment can support a different subset of chains without forking the engine's core code.

## Implementation Decisions

- **Processes**: an API service and a separate worker process, sharing one Postgres database as an outbox (ADR-0009). The worker never receives HTTP traffic; the API never talks to a Chain Handler or Signer directly.
- **Domain types**: `Dispatch`, `Call` (the primitive — `{to, data, value}` on EVM-shaped chains, `{programId, accounts, data}` on Solana-shaped ones), `Payment` (a convenience shape translated into a `Call` at the API layer, ADR-0018), `Transaction`, `Attempt`, a status set including `ABANDONED` distinct from `FAILED` (ADR-0004). A `Result<T, DispatchError>` convention for expected outcomes; exceptions reserved for truly unexpected failures (ADR-0010).
- **Structured errors**: `{ code, message, chainDetail? }`; initial `code` set: `INSUFFICIENT_FUNDS`, `INVALID_RECIPIENT`, `SIGNER_UNREACHABLE`, `CHAIN_REJECTED`, `RPC_UNAVAILABLE`, `CHAIN_NOT_ENABLED` (ADR-0010, ADR-0019).
- **Repository**: a domain-shaped interface (claim queued work, record a broadcast, mark abandoned/failed/confirmed) with a real Postgres/Drizzle implementation and an in-memory fake (ADR-0011).
- **Signer**: one concrete client function calling a configured HTTP endpoint (`POST /sign {chain, curve, address, unsignedTxBytes} -> {signature}`) — no interface/abstraction layer (ADR-0002, ADR-0012). A separate reference local-keyfile Signer service, never imported by the engine's own code, wired into `docker-compose.yml`.
- **Chain Handler interface**: `validatePayment`/`validateCall`, `prepare`, `sign` (delegates to the Signer client), `broadcast`, `getStatus`, `getBalance` — opaque unsigned/signed transaction payloads, never chain-shaped assumptions at this layer. A conformance test suite, exported from the core and runnable against any implementation.
- **Registry**: populated from an `ENABLED_CHAINS` config value; each named chain's Chain Handler module is dynamically imported and registered, anything unlisted is never imported (ADR-0019). Package-per-chain split confirmed as the eventual shape but deferred past the hackathon (ADR-0020) — chains remain folders in one package for now (ADR-0014).
- **Coordinator**: claims queued Dispatches via the repository, runs Funding Check (aggregate required amount per asset vs. the Sender's real balance, ADR-0024) before forming any Execution Plan, calls the registered Chain Handler, applies Retry Policy and the chain-aware `ABANDONED` timeout (ADR-0003/0004). Holds no chain-specific logic.
- **API**: `POST /v1/dispatch` and `GET /v1/dispatch/:id`, wire format pinned in `docs/api.md`. Auth via a single configured bearer token (ADR-0022); `Idempotency-Key` required and checked against the repository before creating a new Dispatch (ADR-0021). No chain or Signer interaction on this path.
- **Persistence**: Postgres only, no alternate backend (ADR-0008).
- **DI/packaging**: plain constructor injection, no framework; one package, chains as folders (ADR-0014).
- **License**: MIT (ADR-0025).

## Testing Decisions

Two tiers (ADR-0013), and this spec only exercises the first:

- **Pure unit tests, no I/O**: the Coordinator's orchestration logic (Retry Policy decisions, `ABANDONED` timing, Funding Check aggregation) tested against the fake repository and `FakeChainHandler` — a hand-rolled double built with `vi.fn()` per method, defaulting to success and overridable per test — injected via plain constructors. This is distinct from issue 05's `StubChainHandler`, which stays fixed/no-op: `StubChainHandler` exists solely to prove the conformance suite itself catches what it's supposed to, and can't produce the branches the Coordinator's orchestration logic needs exercised (a `prepare`/`sign` failure, a `FAILED` on-chain status, an RPC error from `getStatus`). `FakeChainHandler` is the one Chain-Handler-shaped double the Coordinator's own tests (and any later scaffold logic needing the same kind of branch coverage, e.g. issue 09's Funding Check) should use; `StubChainHandler` stays deliberately trivial and is never asked to grow that configurability.
- **Route-level tests**: `POST /v1/dispatch`/`GET /v1/dispatch/:id` tested via Fastify's `inject()`, backed by the fake repository — auth rejection, idempotency-key replay, and validation are asserted at the HTTP boundary, not by calling internal functions directly.
- **Conformance suite tests**: run against `StubChainHandler`, a trivial no-op stub, here, solely to prove the suite itself catches what it's supposed to (mutated input, swallowed errors, premature `CONFIRMED`). Running it against a *real* Chain Handler's real behavior is `solana-chain-handler`'s responsibility, under ADR-0013's real-RPC discipline — explicitly out of scope here.

No fake Chain Handler is used to validate real chain behavior anywhere in this spec — `FakeChainHandler` and `StubChainHandler` both exist only to validate the Coordinator's and conformance suite's own logic in isolation, which is a different, legitimate use (as already clarified when this spec was first drafted).

## Out of Scope

- Any real Chain Handler (Solana, EVM, or otherwise) — see `.scratch/solana-chain-handler/`.
- Relay Dispatch — spec drafted at `.scratch/relay-dispatch/`, issues deferred until this and Solana's broadcast/status/retry work land (ADR-0026).
- Sender Pool (ADR-0016), Bulk Call (ADR-0006), Durable Nonce Execution (ADR-0007) — all chain-specific or deferred, not part of the core scaffold.
- Webhooks — deferred, polling is the required baseline for this spec (ADR-0023).
- Package-per-chain split — confirmed direction, deferred past the hackathon (ADR-0020).
- Multi-tenant API key issuance/rotation — explicitly rejected; there is no tenant concept here (ADR-0022).

## Further Notes

Full reasoning lives in `CONTEXT.md` and `docs/adr/0001`–`0026`; the wire format lives in `docs/api.md`. This spec sits above the nine existing tickets in `.scratch/core-engine-scaffold/issues/` (`01`–`09`), which remain the execution-level breakdown — this document is the feature-level spec the issue-tracker convention (`docs/agents/issue-tracker.md`, preserved in `old-docs/`) expects above them.
