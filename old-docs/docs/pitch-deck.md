# Dispatch — Pitch

Working document for the pitch. This is not the deck itself; it's the source material and argument the deck gets built from. Sections marked `[TBD: ...]` are waiting on research or a decision, not filled in with a guess.

## Problem

Any team that needs to pay out to many recipients across blockchains (payroll, creator or affiliate payouts, refunds, rewards) runs into the same wall: reliably executing a batch of payments across chains is a real distributed-systems problem, not a scripting task.

Concretely, doing it correctly means handling, per chain, for every run:

- EVM nonce management, so concurrent broadcasts from one sender don't collide
- Solana transaction size and instruction-count limits, so a batch of payments doesn't just fail as one oversized transaction
- RPC flakiness and rate-limiting, so one bad response doesn't silently stall an entire run
- Idempotency, so a retried request (a timeout, a double-click) can't double-pay anyone
- Partial failure, so a batch of 500 payments where 3 fail doesn't require re-touching the 497 that succeeded
- Reconciliation, so "the RPC accepted my transaction" is never treated as "the payment settled"
- A recipient who doesn't have a wallet yet, so the payment doesn't just fail or wait on a manual off-chain workaround

Today, a team either builds this themselves (and gets some part of it wrong under real load) or falls back to a consumer-facing multisend tool with no API, no per-payment lifecycle tracking, and no reliability guarantees. Neither is what a business that runs payroll or payouts on a schedule can build a real operation on.

## Solution

Dispatch is a headless, API-first execution engine that turns a declared payment outcome into reliable, tracked blockchain execution, without the caller needing to understand any single chain's execution model.

The interface is one endpoint:

```
POST /v1/dispatch
Idempotency-Key: payroll_oct_15_run_01

{
  "payments": [
    { "id": "alice", "chain": "solana", "asset": "USDC", "recipient": "9vxz...vxyP", "amount": "1200.00" },
    { "id": "bob",   "chain": "base",   "asset": "USDC", "recipient": "0x86B6...deea", "amount": "950.00" }
  ]
}
```

Everything after that call is Dispatch's problem, not the caller's:

- **Idempotency by default.** Resubmitting the same `Idempotency-Key` returns the original dispatch. Enforced at the database level, not just in application logic, so two concurrent requests can't race past a check and both create dispatches.
- **Chain-agnostic orchestration.** An Execution Coordinator groups a dispatch's payments by chain and hands each group to a chain-specific `ChainExecutor`. Adding a new chain means writing one new executor file; nothing else in the platform changes.
- **Bring-your-own-signer.** Dispatch never holds raw private keys for a tenant's sender wallet. Every signature comes from an external Signing Provider (Turnkey or Privy today), selectable per chain via config.
- **Full lifecycle tracking.** Every payment moves through an explicit status (`QUEUED` → `PROCESSING` → `BROADCASTING` → `CONFIRMING` → `CONFIRMED`, or `FAILED`, or `AWAITING_FUNDS`), independently, so a partial failure never hides behind a batch-level status.
- **Webhooks, not required polling.** `payment.broadcasted`, `payment.confirmed`, `payment.failed`, `dispatch.completed`, `dispatch.partially_failed` fire as they happen; `GET /v1/dispatch/:id` is there for when polling is preferred instead.
- **Pay someone without a wallet.** A recipient can be a phone number instead of an address. On Solana, Dispatch generates a real, shareable TipLink claim link; everything needed to control the funds lives in the URL itself, no account or app required on the recipient's end.

### Proof, not just architecture

The strongest part of this pitch is that the above isn't a design doc; it's been run for real, at volume, and the rough edges that only show up under load have already been found and fixed:

- A single dispatch of 500 mixed-chain payments (245 Base, 250 Solana, 5 phone/claim) run end to end: **495/500 confirmed**. The other 5 failed for a specific, correct on-chain reason (a new claim wallet must receive at least Solana's rent-exemption minimum, and the demo script under-funded those particular payments) — a real demonstration of the partial-failure model working as designed, not a bug.
- Idempotency confirmed live: resubmitting the exact same request with the same `Idempotency-Key` returned the original `dispatch_id`, with zero duplicate payments created.
- Three real infrastructure bugs found and fixed under real volume, not left as theoretical edge cases in a spec:
  1. A stale Solana blockhash bug, from fetching `getLatestBlockhash()` too early in a sequential batch loop, causing later batches to fail with `Blockhash not found`.
  2. A public devnet RPC that started rate-limiting under reconciliation load, and a reconciliation loop with no per-transaction error isolation, so one `429` silently blocked every other in-flight transaction from ever being checked again.
  3. The rent-exemption edge case above.

## Competitive landscape

Researched 2026-09-20, primary sources cited per entry; anything sourced from a third-party aggregator rather than the company's own page is flagged as such.

- **Bridge** (bridge.xyz, acquired by Stripe, deal closed Feb 4 2025 for $1.1B). The closest true conceptual competitor: Bridge's own "Orchestration" product ([bridge.xyz/product/orchestration](https://www.bridge.xyz/product/orchestration)) is explicitly "give us a batch, we route and execute it," same shape as Dispatch. But its conversions are fiat-to-stablecoin and stablecoin-to-fiat, not chain-to-chain execution reliability or crypto-to-crypto routing. Pricing (Stripe stablecoin acceptance ~1.5%/transaction, Bridge FX spread up to 1%) is sourced from a third-party summary ([eco.com](https://eco.com/support/en/articles/15083178-bridge-xyz-stablecoin-api-for-payouts-and-orchestration)), not Bridge's own pricing page; unconfirmed at first hand.
- **Circle / CCTP** (Cross-Chain Transfer Protocol). Native USDC burn-and-mint across 13+ mainnet chains (Solana added Oct 2025), ~8-20s settlement via Fast Transfer. This is a *protocol primitive*, not a payout API: a team using CCTP directly still has to build batching, idempotency, per-payment lifecycle tracking, and retries themselves. That gap is exactly Dispatch's layer. ([circle.com/cross-chain-transfer-protocol](https://www.circle.com/cross-chain-transfer-protocol), [developers.circle.com/cctp](https://developers.circle.com/cctp))
- **Sphere** (spherepay.co). API-first on/off-ramp and multi-chain stablecoin transfer across 7 chains, sub-30-minute settlement, built-in KYC/KYB for 160+ markets. Closer to fiat-conversion and compliance infra than to execution-reliability engineering. ([spherepay.co](https://spherepay.co/), [docs.spherepay.co](https://docs.spherepay.co/introduction))
- **Mural Pay**. Stablecoin-native B2B payout API with real production scale: >$200M annual stablecoin volume, 5,000+ monthly payments, named customers including Opera, Deel, Bolt, and Koywe. The most direct "payout API at real scale" comparator found. ([muralpay.com](https://muralpay.com/))
- **Request Finance**. Crypto invoicing/payroll across 350+ tokens and 18 chains, but the workflow is invoice-to-multisig (Gnosis Safe) approval, not a developer-facing execution API. Aimed at finance teams, not backend engineers. ([request.finance/payroll](https://www.request.finance/payroll))
- **Utopia Labs**. DAO payroll/expense tooling built on top of Gnosis Safe batch transactions ($25.3M raised, Paradigm-led, per a 2021 TechCrunch report — unconfirmed current 2026 product state). A product layer on top of Safe, not a chain-execution engine itself.
- **Rain**. Stablecoin card issuer and Visa Principal Member ($1.95B valuation, Jan 2026); payroll is a bolt-on partnership (with Toku) across USDC/USDT/DAI/PYUSD on five chains, not Rain's core infra product. ([rain.xyz](https://www.rain.xyz/))
- **Fireblocks**. Pure custody/MPC key-management infra. Payout workflows exist only as something partners (e.g. Crossmint) build on top of Fireblocks, not a Fireblocks-native disbursement product — confirms that custody infra and an execution/reliability engine are different layers of the stack. (Secondary-sourced; not confirmed directly against Fireblocks' own product pages.)
- **Squads / Altitude**. The most direct Solana-native comparator: Altitude (public Dec 2025) is a stablecoin business-account product for payroll and vendor payouts on self-custody Squads accounts. $18M raise (May 2026, Solana Ventures-led); claims $20B in annualized stablecoin transfer volume as of Sept 2026 — a broad infra-activity metric, not directly comparable to payout-API transaction volume, and worth treating as such rather than a like-for-like number. ([solanacompass.com](https://solanacompass.com/news/altitude-reaches-20b-in-annualized-stablecoin-transfer-volume-on-solana))

No other direct "batch payout API across multiple chains, execution-reliability-first" competitor surfaced. **Dispatch's actual gap in this landscape**: everyone above is either a fiat-conversion/compliance layer (Bridge, Sphere), a protocol primitive with no orchestration (CCTP), a workflow product built on someone else's execution layer (Request Finance, Utopia Labs, Altitude), or custody infra one layer below execution (Fireblocks). Nobody found positions specifically as "a chain-agnostic execution engine with per-payment lifecycle tracking, idempotency, and reconciliation as the product," which is Dispatch's actual claim.

## Competitive positioning

Dispatch positions as the execution and reliability layer underneath payouts. Not a payments product, not custody, not compliance infrastructure.

Every competitor in the landscape above sits one layer away from what Dispatch actually does:

- **Bridge and Sphere** handle fiat-to-stablecoin conversion and compliance (KYC/KYB, FX). Dispatch has no fiat leg and no compliance layer. It moves an asset the tenant already holds.
- **Circle's CCTP** is a protocol primitive: a way to move USDC across chains. It has no orchestration layer. A team using CCTP directly still has to build batching, idempotency, and lifecycle tracking themselves, which is exactly what Dispatch already built.
- **Fireblocks** is custody infrastructure (MPC key management). Dispatch is bring-your-own-signer: it never holds raw private keys, and it sits above whichever signer a tenant chooses (Turnkey, Privy today), not below it.
- **Request Finance, Utopia Labs, and Squads' Altitude** are workflow products built on top of someone else's execution layer (a multisig, a self-custody account). None of them offer the execution engine itself as a standalone, developer-facing API.

No competitor researched claims "chain-agnostic execution engine, with idempotency, per-payment lifecycle tracking, and reconciliation, as the product itself." That is Dispatch's specific claim, and it is the one claim backed by real proof (the 500-payment demo, the idempotency test run live, the three infrastructure bugs found and fixed under real load) rather than a diagram.

This is a deliberate choice against two alternatives considered and rejected:

- Competing head-on with Bridge or Sphere on fiat-to-stablecoin conversion would require building a compliance layer (KYC/KYB, banking relationships) Dispatch has none of, and shouldn't build for a hackathon.
- Competing head-on with Squads' Altitude as "the Solana-native payout account" would cede the multi-chain story, which is Dispatch's actual architectural strength (adding a chain is one file, nothing else changes), for a narrower Solana-only claim.

**The tradeoff**: this is a "boring infrastructure" position, not a flashy named vertical. It bets that credibility, a real, verified claim nobody else in this landscape makes, outperforms a punchier but unproven story, given that Dispatch already has the proof to back it.

## Why now

Verified 2026-09-20, primary/near-primary sources cited; the market-cap figure is from an aggregator tracker, not an issuer or regulator's own dashboard, and is flagged as such.

- **Stablecoins are a genuinely large and fast-growing market.** Total stablecoin market cap is approximately $302.8B as of Sept 10 2026, up from $161.5B in mid-2024 (roughly 95% growth in two years); USDT holds 60.6% share ($183.4B), USDC $74.2B. ([stablecoinbeat.com/tracker](https://stablecoinbeat.com/tracker/), an aggregator, not an issuer's own figure.)
- **US regulatory clarity has arrived, with the compliance deadline still ahead.** The GENIUS Act was signed into law July 18 2025 (P.L. 119-27). Regulators missed the July 18 2026 deadline for final implementing rules, so the effective date now falls to the statutory 18-month backstop: **Jan 18, 2027**. This means the legal framework for payment stablecoins exists now, and the compliance window is closing over the next several months, i.e. the market is moving from "unregulated experimentation" to "build on this now, be ready when enforcement starts." ([congress.gov](https://www.congress.gov/crs-product/IN12553), [federalregister.gov](https://www.federalregister.gov/documents/2026/08/18/2026-16796/genius-act-regulations-on-payment-stablecoin-issuance-offer-and-sale))
- **Circle, the issuer of the asset Dispatch actually moves, is a public company under real market scrutiny.** Circle listed on the NYSE June 5 2025, raising $1.054B; it has since traded between a $298.99 high (Jun 23 2025) and a $49.90 low (Feb 5 2026), around $91.78 in mid-September 2026. USDC's issuer being public and liquid is itself a signal of stablecoin infrastructure maturing into a real asset class, not a speculative side-bet. ([stockanalysis.com/stocks/crcl](https://stockanalysis.com/stocks/crcl/))
- **Solana-native competitors are already proving real volume exists.** Squads' Altitude claims $20B in annualized stablecoin transfer volume as of September 2026 (see Competitive landscape above) — evidence that Solana-based stablecoin payout infrastructure has genuine, current demand, not a hypothetical future market.

**Hackathon fit** (re-verified against colosseum.com/hackathon, fetched 2026-09-20): the live hackathon is "Crypto World's Fair," Sep 14 - Oct 12 2026, 4,780 registered builders, open across all blockchain ecosystems with no single named "payments" or "infrastructure" track. Judging weighs founder/market fit, product quality and competitive positioning, market size and growth, founder communication, and business viability/traction — which is exactly why this document treats competitive landscape and market timing as first-class pitch content, not an afterthought to the technical demo.

## Target audience

Distinct from competitive positioning above: this is about who Dispatch serves, not how it differs from competitors. Horizontal infrastructure, not a single vertical. The deck presents multiple use cases side by side rather than committing to one wedge customer:

- Payroll and contributor payments for web3 companies and DAOs
- Creator and affiliate payouts for consumer crypto apps
- Refunds and rewards

This is a deliberate choice: Dispatch's differentiation is the reliability and multi-chain abstraction layer itself, not a single audience's workflow on top of it.

## Business model

Volume-based SaaS tiers: pricing gated by dispatch volume and feature access (webhooks, multi-tenant seats, live-chain access), rather than a flat per-transaction fee. No tier structure or pricing numbers exist in the product today; this section is a placeholder for real figures, not invented ones, per the "never invent a stat" rule this codebase already holds itself to (`docs/design/00-brand-and-visual-system.md`).

## Explicitly out of scope for this pitch

The self-deciding payment routing engine discussed earlier in this project (resolving a payment intent across a recipient's multiple wallets, potentially swapping assets to find the best payout) is not part of this pitch, not even as a roadmap teaser. That idea was set aside.
