Status: designed 2026-10-31; ADR-0057 and ADR-0058 accepted; no tickets filed yet; builds on `web-console`

# Flag Rules: hold a Dispatch for an operator

ADRs: 0022, 0046, 0056, 0057 (operator token), 0058 (Flag Rules). Depends on `.scratch/web-console/spec.md`.

## Problem Statement

A Managed Dispatch goes straight from submission to signing. The Signer's policy can refuse outright, but there's no middle ground: no way for an operator to say "a payment over 5,000 USDC, or to an address we've never paid, should wait for someone to look at it". A wrong file, a mistyped amount or a runaway client is only noticed after the money moved.

## Solution

Operators set Flag Rules in the console. `POST /v1/dispatch` checks each Managed Dispatch against them; a match stores the whole Dispatch as `held`, which the worker never claims. An operator then releases it (with a reason) or cancels it. Release and rule edits need `OPERATOR_TOKEN` (ADR-0057). Decisions and rejected alternatives are in ADR-0058.

## User stories

1. As an operator, I want to set rules in the console without restarting the engine.
2. As an operator, I want a Dispatch that breaks a rule to wait, whole, before anything is signed or proposed.
3. As an operator, I want to see exactly which items matched which rule, then release with a reason or cancel.
4. As an operator, I want to preview how many of the last 30 days' Dispatches a rule would have held before I switch it on.
5. As an operator, I want every cancel, release and rule change recorded with a time and reason, and listed in the console.
6. As a security reviewer, I want an API client unable to release its own held Dispatch or change the rules.
7. As a Relay Dispatch caller, I want my transaction never held.

## Rules (per chain; amounts per asset, in display units)

| Rule | Matches when |
|---|---|
| Item over | one `payment` item's amount exceeds the limit |
| Dispatch total over | the Dispatch's payments of an asset add up to more than the limit |
| First-time recipient | this engine has no confirmed payment to the recipient on this chain |
| Recipient not allowlisted | the recipient is not on the rule's list |
| Call target not allowlisted | a `call` item's `to` (Base) or `programId` (Solana) is not on the rule's list |
| Daily volume over | accepted, not cancelled, Managed Dispatches of the asset in the last 24 h, plus this one, exceed the limit |

Each rule has a name, an on/off switch and a version. A Bulk Call's items are checked like any others.

## Wire changes (`docs/api.md`)

- New status `held`, top-level and per item. `POST /v1/dispatch` answers `202 { dispatchId, status: "held" }` on a match.
- A `hold` block on a held or released Dispatch: `{ matched: [{ rule, ruleId, ruleVersion, items: [indices] }], heldAt, releasedAt?, reason? }`.
- `POST /v1/dispatch/:id/release` (operator token): `{ reason }` required; `200` with the Dispatch `queued`; `409` unless it is `held`.
- Cancel (ADR-0056) works on a `held` Dispatch with either token.
- `GET/POST/PUT/DELETE /v1/flag-rules` (operator token; read also allowed with `AUTH_TOKEN`); `POST /v1/flag-rules/preview` returns the would-have-held count and examples over the last 30 days.
- `GET /v1/activity` (operator token): cancels, releases, rule changes, newest first.

## Console

- Signs in with `OPERATOR_TOKEN` when set; otherwise as in `web-console`, with the Held and Rules pages hidden.
- **Held:** the review queue, oldest first, with time held; detail shows matched items highlighted, Release (reason required) and Cancel.
- **Flag Rules:** list, editor, version history, preview before saving.
- **Activity:** the audit list.
- Overview gains the oldest hold.

## Out of scope

Holding Relay Dispatch. Per-item holds. Hold deadlines. Re-checking held Dispatches after a rule edit. Named operators or multi-person release. Rules over a `call` item's decoded amount.

## Testing

- Offline: each rule's matcher, including edge amounts and decimals; the ingest path stores `held` and the worker never claims it; release/cancel race on real Postgres; versioning (a held Dispatch keeps its matched version after an edit); token separation (`AUTH_TOKEN` gets `403` on release and rule writes).
- `web/`: the Held and Rules pages against fixture responses.

## Proposed issues

1. `OPERATOR_TOKEN` and the activity record (ADR-0057).
2. Flag Rule storage, versioning and the `/v1/flag-rules` routes.
3. Matchers for the six rules, and the check in `POST /v1/dispatch`; `held` status and `hold` block (ADR-0058).
4. Release endpoint; cancel on a held Dispatch.
5. Preview over the last 30 days.
6. Console: operator sign-in, Held queue, Flag Rules editor, Activity, Overview's oldest hold.
7. Docs: Flag Rules guide, API reference, and what they do not protect against.

## Settled

- Hold, never refuse or only mark; whole Dispatch; checked at submission.
- Mistake-catcher, not a security control; the Signer's policy holds the hard limits.
- Managed Dispatch only, Multisig Senders included (held before any Proposal).
- No deadline; rule edits forward-only.
- All six rules in the first version.
