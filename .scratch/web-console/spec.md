Status: designed 2026-10-31; ADR-0056 accepted; design pattern in `design.md`; tickets #109–#114 and #121–#127 filed

# Web console and docs site

ADRs: 0022, 0023, 0046, 0055, 0056 (cancel). Followed by `.scratch/flag-rules/spec.md`.

## Problem Statement

The engine is only visible through `GET /v1/dispatch/:id` and the logs. An operator can't see what this instance is doing right now, which Dispatches are in flight, what happened to a Transaction along the way (resubmits, fee bumps, approval waits), or what the Senders and their Signer keys look like. There is no way to withdraw a Dispatch queued by mistake. The docs are five Markdown files written for us, not for someone setting the engine up for the first time.

## Solution

A web console served by the engine's own API process, reading only this instance, plus a `/docs` site rendered from `docs/`, plus a public landing page. The look and motion of all three are set in `design.md`. The console is read-only except for cancel (ADR-0056). The engine gains the read endpoints the console needs, as documented public `/v1` routes, so any API client can use them too.

## User stories

1. As an operator, I want an Overview of this instance: enabled chains and Senders, counts by status, the oldest unclaimed Dispatch, recent Dispatches.
2. As an operator, I want to list and filter Dispatches by chain, mode, status and date, and see rows change as statuses change.
3. As an operator, I want a Dispatch's full timeline, down to every Transaction version and Attempt, with times, so I can see a resubmit or a fee bump happen.
4. As an operator of a Multisig Sender, I want each Proposal's votes, threshold and deadline, and a link to open it in Squads or Safe.
5. As an operator, I want to see each Sender: address, mode, multisig, the engine's own key, balances and committed amounts, and the Signer key's backend, policy and pins, with no secrets.
6. As an operator, I want to cancel a Dispatch that hasn't been claimed yet, and be told plainly when it's too late.
7. As someone new to the engine, I want docs that get me from nothing to a confirmed Dispatch, with examples I can paste and that work.
8. As an operator, I want the console to look and move like a finished product, in light and dark.
9. As someone hearing about the engine for the first time, I want a landing page that shows what it does and gets me to the docs or GitHub.

## Engine API (all `/v1`, bearer `AUTH_TOKEN`, documented in `docs/api.md`)

- **`GET /v1/dispatches`**: newest first, cursor-paginated (`?cursor`, `?limit` ≤ 100), filters `chain`, `mode`, `status`, `from`, `to`. Each row is the `GET /v1/dispatch/:id` summary plus `createdAt`, item count and per-asset totals.
- **`GET /v1/dispatch/:id?include=timeline`**: adds a `timeline` built from stored timestamps: Dispatch created and claimed; per Transaction version: written, broadcast, each Attempt, replaced/dropped, confirmed/failed/abandoned; per Proposal: created, approvals as last read, timed out, resolved. Needs one new column, `transactions.failed_at`. No event table (ADR-0014).
- **`GET /v1/senders`**: one entry per enabled chain: Sender address and mode (`single`, `squads`, `safe`), multisig or Safe address and threshold, the engine's key (member key or executor), native and known-token balances, `committed` per asset (the Funding Check's numbers), and the Signer key's `curve`, pins and backend as the Signer reports them. Fetched server-side; the browser never talks to the Signer. Balance reads hit RPC, so results are cached for 15 s.
- **`POST /v1/dispatch/:id/cancel`** (ADR-0056): `200` with the Dispatch now `cancelled`; `409 { error: { code: "ALREADY_CLAIMED" } }` once claimed; idempotent on an already-cancelled one. Atomic against the worker's claim.

## Console

- **Package:** `web/`, a sibling of `signer/` and `verifier/`: Vite, React, TypeScript. Two builds (`design.md`, Surfaces and routes): the **engine build**, served by the API process at `/console/*` and `/docs` with `/` redirecting to `/console`, same origin; and the **public build**, the landing page at `/` plus `/docs`, for static hosting. If `web/` is not built, the API runs as today.
- **Sign-in:** paste `AUTH_TOKEN`; kept in `sessionStorage`. `/docs` needs no token.
- **Live updates:** polling about every 2 s while anything shown is in flight, backing off when all is terminal; Senders every 15 s. No push infrastructure (ADR-0023).
- **Pages:** Overview; Dispatches; Dispatch detail (items, timeline, approval blocks with `chainRef` links, Cancel when unclaimed, "reject it in Squads/Safe" for an open Proposal); Senders & Keys; Docs. Activity arrives with `flag-rules`.
- **Design:** `design.md`, built with the `design-taste-frontend` skill. The console follows Copilot's web app; the landing page combines Mobbin's hero with Webflow's sticky-nav feature blocks. Near-monochrome, ink primary buttons, one accent (international orange `#FF4F00`) for "look here", tinted status pills. Spring layout motion in the console, scroll reveals on the landing page; honours `prefers-reduced-motion`; works at phone width.

## Docs

`docs/` stays the source; the site renders it at build time. Restructured and rewritten in place, in plain human prose:

- **Get started:** what Dispatch is; Docker Compose quickstart; first Dispatch with `curl`.
- **Concepts:** from `CONTEXT.md`, explained, not pasted.
- **API reference:** every endpoint, request, response and error code.
- **Guides:** Signer setup, Multisig (Squads, Safe), Relay Dispatch, Bulk Call.
- **Operations:** every environment variable, the console, troubleshooting, mainnet checklist.
- **Decisions:** `docs/adr/`, browsable.

`CONTEXT.md` and `docs/adr/` stay where `AGENTS.md` expects them. Every `curl` example is run against a local devnet or Sepolia engine before it is committed.

## Out of scope

Flag Rules, release, the operator token and the Activity page (`flag-rules`). Submitting a Dispatch from the browser. Webhooks or push. User accounts. Cancelling a claimed Dispatch or a single item.

## Testing

- Offline tier: route tests for the four endpoints, including the cancel/claim race on real Postgres and the timeline built from fixture rows.
- `web/`: component tests for status rendering and the timeline; a build check in CI so a broken console fails the PR.
- Docs: a script that extracts each `curl` block, so they can be run against a local engine before release.

## Issues

Filed: #109 timeline, #110 list, #111 senders, #112 cancel, #113 docs rewrite (Get started, Concepts, API), #114 docs rewrite (Guides, Operations).

Filed after `design.md`: #121 `web/` scaffold, #122 shell and sign-in, #123 Overview, #124 Dispatches and detail pane, #125 Senders & Keys, #126 docs site, #127 landing page.

## Settled

- Live data from this one instance only; no demo or simulated data.
- Read-only plus cancel; more write actions later.
- "Account details" means the Sender: its addresses, balances and Signer key, never key material.
- Timeline rebuilt from stored timestamps, not an event log.
- Polling, not push.
- One `web/` codebase, two builds; a self-hosted engine never serves the landing page.
