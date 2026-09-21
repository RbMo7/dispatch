Status: ready-for-agent

# Core engine scaffold

## Problem Statement

Nothing chain-specific can be built yet — there is no Chain Handler interface to implement, no repository to persist against, no Coordinator to plug into, and no Signer client to call. This is the chain-agnostic skeleton every Chain Handler (Solana first, per `.scratch/solana-chain-handler/spec.md`) builds on top of. See `CONTEXT.md` and `docs/adr/` (especially 0002, 0005, 0009–0017) for the decisions this scaffold implements.

## Solution

A minimal Fastify + Postgres/Drizzle project with: the domain types and structured error shape, a repository module hiding persistence from orchestration logic, a Coordinator that claims/orchestrates/applies Retry Policy and `ABANDONED` timeout logic against a *stubbed* Chain Handler (no real chain yet), a Signer client (single HTTP implementation, no interface), and the Chain Handler conformance test suite harness that real Chain Handlers will be run against starting with Solana.

## Out of Scope

- Any real Chain Handler (Solana or EVM) — this spec produces the skeleton they plug into, not a working chain.
- Relay Dispatch (ADR-0005) — Managed Dispatch's orchestration path only, for now.
- Sender Pool (ADR-0016), Bulk Call (ADR-0006), durable nonce (ADR-0007) — all later.
- A real Signer backend beyond a trivial local-keyfile reference implementation for dev — production KMS/HSM integration is an operator's own concern per ADR-0002.

## Further Notes

The Coordinator's own unit tests use a trivial, no-op Chain Handler stub to test *orchestration* logic in isolation (claim → call handler → apply Retry Policy → mark status) — this is not the same thing ADR-0013 forbids. ADR-0013's rule is about not faking a real Chain Handler's *chain behavior* to validate that handler's own correctness; testing the Coordinator's generic decision logic against a deliberately trivial stub, decoupled from any specific chain, is a different and legitimate use, and should use the fake repository from issue 03, not a real database.
