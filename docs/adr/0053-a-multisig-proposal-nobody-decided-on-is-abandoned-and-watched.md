# A multisig proposal nobody decided on is ABANDONED, and watched for a long window

ADR-0049 said a proposal with no decision by its deadline fails with `APPROVAL_TIMEOUT` and the engine never executes it afterwards. That is not enough, because the engine is not the only party that can execute one. A Squads member with Execute permission can run an approved proposal, and on Safe anyone can submit `execTransaction`. If approvers sign a week late and a human executes, the money moves while the Calls already read `FAILED`, and a caller who re-sent after seeing `FAILED` pays twice. ADR-0004 rejected this for EVM transactions: `FAILED` means the chain rejected it, and "we stopped waiting" is a different thing.

## Decision

This revises the timeout part of ADR-0049. Rejection, stale proposals and the roles are unchanged.

- **A missed deadline makes the Calls `ABANDONED`** with reason `APPROVAL_TIMEOUT`, not `FAILED`. The deadline is `SOLANA_APPROVAL_DEADLINE_MS` / `BASE_APPROVAL_DEADLINE_MS`, default 72 hours from creation, global config only (no per-request override).
- **The engine never executes a proposal after its deadline**, even if it is approved later. Executing a week-old payment run is the operator's call, made in the multisig app.
- **The engine keeps watching the proposal** (not engine-sent transaction hashes, which a human-executed proposal does not have) for a separate window, `SOLANA_APPROVAL_REWATCH_WINDOW_MS` / `BASE_APPROVAL_REWATCH_WINDOW_MS`, default 30 days from `abandonedAt`: at the existing re-watch cadence on the first day, hourly after.
- **What it does when it sees something:**
  - Executed by someone else: the Calls become `CONFIRMED`, and the engine logs `late_execution_detected`.
  - Definitively rejected (Squads reject or cancel; on Safe, the nonce consumed by a different transaction): the Calls become `FAILED` with `APPROVAL_REJECTED`.
  - Approved but not executed: the Calls stay `ABANDONED`, `approval.state` reads `approved_after_deadline`, and the engine logs it loudly at a bounded interval.
  - Window over: the Calls stay `ABANDONED`, and the engine logs `rewatch_window_ended` once.
- **Committed amounts.** On Squads, several proposals can be open at once, so the Funding Check counts the amounts of open proposals, and of timed-out ones still being watched, as committed. On Safe, only one proposal can execute per nonce, and after a timeout the next proposal reuses the Safe's current nonce, so a superseded proposal's Calls fail with `APPROVAL_REJECTED` without having been paid.
- **No push.** Neither chain calls the engine, so all of this is polling. Late outcomes reach a caller only through `GET /v1/dispatch/:id` and the logs until webhooks (ADR-0023) exist; they are the next roadmap item after this feature.

## Considered options

- **Keep `FAILED`** (ADR-0049 as written). Rejected: it invites a double payment.
- **Never time out.** Rejected: Calls would wait forever, and on Safe one stalled proposal holds up every later one.
- **The engine executes late approvals.** Rejected: the payments may be stale, and the caller may already have re-sent them after `ABANDONED`.
- **Push the outcome to the engine** (Safe's Events Service webhooks, Solana websocket subscriptions). Rejected: an exposed inbound endpoint or a websocket dependency, for something polling already covers (ADR-0023).

## Consequences

- A caller treats `APPROVAL_TIMEOUT` like any `ABANDONED` Call: do not blindly re-send; check first (the verifier CLI also shows a proposal's status).
- An operator who wants a timed-out proposal dead must reject it in the multisig app. The engine cannot cancel it.
- After the 30-day window, a late execution goes unseen, and the Calls stay `ABANDONED`. The runbook says so.
- A long approval window means a Squads vault's committed balance stays reserved that long. An operator who does not want that rejects the proposal.
- The `approval` block gains `state` (`awaiting`, `approved`, `approved_after_deadline`), documented in `docs/api.md`.
- On Squads a closed proposal no longer exists. The engine finds an execution by someone else through the proposal address's transaction history, which outlives the account. An approved proposal whose execute failed stays Approved and retryable, so the engine retries it until the deadline rather than reporting `FAILED` while it can still execute.
