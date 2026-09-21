# Sign-in and Auth

This doc exists because "add a sign-in flow" is not a UI task on top of what the backend already has. `CONTEXT.md` today only knows one credential: the **API Key**, a machine-to-machine bearer token issued to a **Tenant**, never tied to a person. There is currently no concept of a human logging in. This doc names the gap precisely and proposes the smallest change that closes it, rather than a full flow-and-pixel spec for something that doesn't have a foundation yet. Treat this as a proposal to review before either design or engineering commits to it: it changes the signup story ADR-0008 just shipped.

**Nothing here touches `CONTEXT.md` yet.** Per this repo's domain-modeling convention, the glossary records what's built, not what's proposed. If the direction below is accepted, the new terms (whatever we land on for "a human identity tied to a Tenant") get written into `CONTEXT.md` at implementation time, alongside the ADR that records the decision.

## The actual gap

Today: `POST /v1/tenants` is anonymous and instant. No email, no password, nothing human-identifying. It returns wallets and an API key to whoever called it, in one request. That was a deliberate self-serve choice (ADR-0008) for API integrators, and it works fine for that audience.

A dashboard changes the audience. A human needs to return tomorrow and see the same Tenant's Dispatches. That requires *something* that identifies them across visits, a login, and right now the only credential in the system is a secret meant to be shown once and used from a backend, not typed into a browser session on a schedule.

## Recommended direction: fold signup into sign-in, via Privy

Don't build a second, separate "create an account" flow next to the existing anonymous one. Unify them: the landing page's primary CTA becomes email-based sign-in/sign-up (the same form serves both: a new email creates a Tenant, a known email logs into the existing one), and `POST /v1/tenants`-the-backend-call still runs underneath it, just after a verified identity exists instead of before.

**Why Privy specifically**: it's already a dependency (`@privy-io/node`, used today for wallet custody in `signing/privyProvider.ts`). Privy's actual core product is authentication (email OTP, wallet-connect, social login) with embedded wallets as a feature on top. Using it for human login too means:
- No password storage, no "forgot password" flow, no email-deliverability problem to own.
- One vendor relationship instead of two for everything identity-and-wallet-shaped.
- Wallet-connect as a login option comes for free if it's ever wanted, without being required. Email is the primary path; a company payroll admin should not need a crypto wallet to log into a payments dashboard.

**What this changes about signup**: it becomes stronger, not just different. The security review behind ADR-0008 flagged anonymous signup as an unbounded-cost surface and mitigated it with a rate limit, a floor, explicitly not a complete answer (see that ADR's Consequences). Email verification is the real fix that rate limiting was standing in for. This isn't scope creep riding in on a UI request; it's closing a gap the last piece of work already named.

## The new concept this implies

A Tenant needs exactly one thing added: a way to know which verified identity may act as it in the dashboard. For v1, keep this as simple as the rest of the system has been:

- One human identity per Tenant, created together at signup. No team/multi-member accounts, no roles, no invites yet: the same "don't build for a future requirement" discipline the backend itself follows (see how `payments.tenant_id` was added flat rather than through a permissions table). If multi-member Tenants become real, that's a new ADR when it happens, not a speculative column now.
- This identity is not the API Key. Revoking every API Key a Tenant has must not lock the human out of their own dashboard, and logging into the dashboard must not let someone read or regenerate an API Key's plaintext after the fact (it was already shown once, and that rule doesn't get an exception for humans).

## The session-to-API bridge problem

This is the one piece of real backend design debt in this doc, named so it doesn't get discovered mid-build.

The existing tenant-scoped endpoints (`GET /v1/tenants/me`, `GET /v1/dispatch/:id`, etc.) authenticate via `Authorization: Bearer <api key>`. A signed-in human's browser session is a Privy-issued session, not an API key. The dashboard's browser code should never hold a Tenant's real API key at all; one-time-shown secrets don't get a second life as a stored session credential.

Recommended shape (for a follow-up ADR when the dashboard is actually built, not decided in full here): the Next.js app's own server side acts as the bridge. It verifies the incoming Privy session, looks up which Tenant that identity belongs to, and calls the existing Dispatch API using a credential that never reaches the browser: either a dedicated non-user-visible API Key minted for dashboard-internal use at signup, or a small first-party session-to-tenant lookup added to the API itself. Both are viable; picking one is backend design work that should happen right before dashboard implementation starts, with the actual endpoint shapes in front of whoever decides, not here.

## Flow

**Landing page to sign in.** One entry point, not two buttons for "sign up" vs "sign in" (the header's `Sign in` link and the hero's `Get API key` button both resolve here, though the primary CTA's label should probably become "Get started" once this ships, a copy change, not a layout one).

**Sign-in screen** (`/sign-in`): centered card on the standard `--color-bg`, no split-screen marketing panel beside it. There's nothing to sell someone who already clicked through from the landing page. `LogoMark` above the card, not the full lockup; the wordmark already did its job on the page they came from.

- One email input, one button: `Continue`.
- Below it, a plain-text divider ("or") and a `Continue with wallet` secondary option, at the same visual weight as a text link, not a competing full-size button. Email is the primary path for the reasons above; wallet is offered, not pushed.
- No password field, ever.

**Verification step**: Privy's own OTP/magic-link UI takes over here (embedded, styled to the extent Privy allows to match `--color-surface`, `--color-ink`, and `--color-accent`). Don't rebuild what Privy already provides.

**First-time email**: after verification, provision the Tenant (wallets and first API key) exactly as `POST /v1/tenants` does today, then land on the dashboard Overview with the API Keys screen's one-time reveal panel already open, since this is the one moment the key exists in plaintext and the person is already looking at the screen. Don't make them navigate to API Keys separately to get the thing they just signed up for.

**Returning email**: land straight on the dashboard Overview. No API key is ever shown again on a returning sign-in; plaintext secrets don't get re-displayed because someone forgot to save one the first time. A lost key means creating a new one from the API Keys screen.

**Errors**: an unrecognized email is never an error state distinct from a new signup, since the two are the same flow. A Privy-side verification failure (expired code, etc.) surfaces as a single plain sentence under the input, no modal.
