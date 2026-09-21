# Dispatch Engine — Onboarding

Read this first. It's the fast path to understanding what this repo is before you touch code, docs, or tickets.

## What this is

A multi-chain disbursement execution engine. A Tenant tells Dispatch "send this much to this recipient" via one API call — on a named chain, or with the chain left for Dispatch to pick — and Dispatch handles everything below that line — wallet custody, transaction construction, signing, broadcasting, batching, retries, and confirmation — without the caller needing to understand any single chain's execution model.

**The problem it solves**: sending money to many recipients across multiple blockchains is operationally hard in ways that have nothing to do with *who gets paid what* — EVM nonce management and gas estimation, Solana blockhash freshness and atomic batching, non-wallet recipients (a phone number) needing a claimable link instead of a direct transfer, transient RPC failures needing reconciliation, and idempotency so a retry never double-pays or silently drops a payment. Dispatch is the layer that makes all of that someone else's problem.

**Who it's for**: any business that needs to disburse funds to many recipients — payroll, affiliate payouts, rewards, refunds — and wants to say "send X to Y" once, in one API shape, regardless of which chain Y's address is on.

## The identity that shapes every decision here

Dispatch is explicitly **not** a middleman, custodian, or compliance layer — it's pure execution infrastructure. That's a durable design constraint, not a phase-one omission:

- **No policy, no KYC, no reserve requirements, no gatekeeping** are ever built into it.
- A Tenant can **export their own wallet's private key** at any time — full self-custody exit, because Dispatch doesn't want to be the only way funds can move.
- **No lock-in on funding**: a Tenant's own treasury automation, not Dispatch, decides how and when real money gets loaded — Dispatch just tells it (via a webhook) exactly what's needed and executes the moment it arrives.
- **Sandbox and Live are both real, first-class tiers** on one account with one API Key — a business builds and tests against fake money on the exact same integration surface it'll use for real money, with mainnet execution being a deliberate, explicit opt-in per chain.

If a proposed feature would make Dispatch gatekeep, custody funds beyond executing a signed transaction, or lock a Tenant into using it exclusively — that's a signal to stop and check it against this framing before building it.

## Core mental model

Full precise definitions live in `CONTEXT.md` (the canonical glossary — read it before touching domain code). The short version:

- A **Tenant** integrates with an **API Key** and submits **Dispatches** — each one idempotent via a client-supplied Idempotency Key, so a resubmit returns the original result instead of double-paying.
- A Dispatch is a bag of **Payments** ("send 100 USDC to Alice on Solana"). The **Execution Coordinator** groups Payments by chain and hands them to a chain-specific **Chain Executor**, which decides how to realize them as one or more **Execution Plans** (a Solana batch of 5, an EVM one-payment-per-transaction) and tracks every broadcast **Attempt** independently.
- A Payment may omit its Chain and give **Recipient Addresses** instead (one candidate address per Chain). The **Decision Engine** resolves it to a concrete Chain before the Coordinator ever groups it, picking the cheapest viable **Route Candidate** and persisting every candidate considered as a **Routing Decision** — inspectable, not a black box (ADR-0013).
- **Bring Your Own Signer (BYOS)**: the engine never holds a raw private key. A pluggable **Signing Provider** (Turnkey, Privy) does the actual signing — swappable per chain with zero interface changes.
- A **Claim Provider** handles non-wallet recipients (a phone number gets a real, shareable claim link).
- **Chain** is a fully-qualified family+tier identifier (`base-sepolia`, `base-mainnet`, `solana-devnet`, `solana-mainnet`) — **Sandbox**/**Live** is derived from the `-mainnet` suffix, never a separate stored field.

## What's built, in order

1. **Core execution engine**: idempotent Dispatch submission, the Coordinator/Chain Executor architecture, Solana batching with atomic batch-failure semantics, a DB-owned EVM nonce counter, manual payment retry, a Claim Provider for phone-number recipients, webhook delivery with retry/backoff, and a config-selectable Signing Provider (Turnkey or Privy per chain).
2. **Multi-tenancy** (ADR-0008): self-serve signup provisions a Tenant, two real Privy-custodied wallets, and a default API Key.
3. **Landing page + tenant dashboard** (ADR-0009, human-auth half superseded by ADR-0014): a public marketing site and five dashboard screens (Overview, Dispatches, Wallets, API Keys, Settings).
4. **Wallet controls** (ADR-0010/0011/0012): the Chain rename to fully-qualified identifiers, real Base Mainnet + Solana Mainnet Chain Executors, Tenant Wallet private-key export, Sandbox/Live wallet funding, and Prefunded/Reactive funding modes — a pre-flight balance check that either fails a shortfall immediately or parks it and notifies the Tenant's own automation via webhook.
5. **Decision Engine** (ADR-0013, `.scratch/routing-engine/spec.md`): a Payment can omit its Chain and let Dispatch pick the cheapest viable one, plus two real demo integrations (`examples/ngo-disbursement`, `examples/payroll`) proving the explicit-chain and Decision-Engine-routed paths end to end.
6. **Password-based dashboard login** (ADR-0014): replaces Privy human sign-in entirely — Privy is wallet custody only now. A Tenant gets a login at dashboard signup or after the fact via `POST /v1/tenants/me/set-password`.
7. **Real Solana USDC support + a Coordinator resiliency fix** (ADR-0015): the Solana executor only ever supported native SOL despite the validation layer claiming USDC support — found live via a stuck Dispatch, now fixed with real SPL/Associated-Token-Account handling. `findShortfalls` also no longer lets one bad asset/chain `getBalance` crash the whole Coordinator tick.

Current state: everything above is committed on `main`. Backend test suite passes 143/144 (one flaky test depends on a public devnet faucet's own rate limit, not a code defect). No real mainnet funds have ever been moved by this engine — mainnet support today is registration, balance reads, and wallet creation only.

**Known gap, not yet fixed**: the Decision Engine's `routing_decision` (which Chain was picked and why) is returned by `GET /v1/dispatch/:id` and rendered by the two demo pages, but the tenant dashboard itself doesn't show it yet — a real tenant checking their own dashboard can't currently see the routing comparison, only the demo pages and the raw API can.

## Where to look next

- `CONTEXT.md` — the domain glossary. Read before writing or reviewing any domain code.
- `docs/adr/` — every hard-to-reverse architectural decision, numbered in order. Read the ones touching whatever you're about to change.
- `.scratch/<feature-slug>/spec.md` and its `issues/` — the spec-and-tickets trail for each feature (`tenant-dashboard`, `wallet-controls`). Each ticket's Comments section records real implementation deviations discovered along the way, not just what was planned.
- `AGENTS.md` — this repo's own workflow conventions (issue tracker location, triage labels, domain-doc discipline).
- `docs/design/` — visual/UX specs for the landing page, dashboard, and sign-in flow.

## Running it locally

```
npm install
docker compose up -d          # Postgres
npm run db:migrate
npm run dev:api                # Fastify API
npm run dev:web                # Next.js app (landing + dashboard)
npm test                       # api test suite (real chain/DB integration, not mocked)
```

Needs a real `.env` (see `.env.example`) — Postgres URL, Privy credentials, Turnkey credentials, and chain RPC URLs. Mainnet RPC URLs default to public endpoints if unset, so balance reads work with no paid RPC key.
