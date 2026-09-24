Status: ready-for-agent

# Bounded low-frequency re-watch of ABANDONED transactions

The Coordinator (issue 06) implements the ABANDONED timeout decision but not what ADR-0004 and spec.md's user story 19 both call for immediately after it fires: "the engine keeps a low-frequency background check running for it, for a bounded window, and reports if it does [confirm]" (CONTEXT.md's `ABANDONED` entry); "an `ABANDONED` transaction still watched at low frequency for a bounded window, so that I find out if it confirms after all" (spec.md story 19).

As built, `DispatchStore.listPendingTransactions` (and both its implementations) filter on `status === 'PENDING'` only. The moment `Coordinator.maybeAbandon` calls `markAbandoned`, that Transaction is permanently excluded from every future `pollPendingTransactions` call — nothing ever checks it again, so a payment that actually lands on-chain after all is never detected or reported.

Needs a design decision before implementation, not just a mechanical fix:

- What "low frequency" and "bounded window" actually mean (a separate, longer poll interval? a separate repository query keyed on `ABANDONED` + a `abandonedAt` timestamp, with a cutoff after which it's no longer even low-frequency-checked?).
- Whether an `ABANDONED` transaction that's later found to have confirmed changes its own status (to `CONFIRMED`?) or gets reported some other way (a distinct event/webhook-shaped concept, given webhooks themselves are deferred per ADR-0023) — this has a real caller-facing consequence, since ADR-0004's whole point is that a caller must not double-pay a recipient whose original transaction quietly confirmed after being marked `ABANDONED`.
- Whether this belongs in `Coordinator.pollPendingTransactions` itself (a second, slower branch) or as a wholly separate poll loop.

Surfaced during issue 06's code review (2026-09-22) — not fixed there, since it's new scope requiring its own design decision, not a bug in what issue 06 already implements.

## Comments

Design decisions (2026-09-24), resolved before implementation:

- **"Low frequency"/"bounded window"**: both. A separate, much slower poll cadence (`REWATCH_INTERVAL_MS` in `worker.ts`, independent of the main `POLL_INTERVAL_MS`) *and* a separate repository query, `DispatchStore.listAbandonedTransactions(limit, notAbandonedBefore)`, keyed on `status === 'ABANDONED'` and a new `abandonedAt` timestamp column/field. `notAbandonedBefore` is the bounded-window cutoff (default 24h, `DEFAULT_ABANDONED_REWATCH_WINDOW_MS` in `coordinator.ts`) — a Transaction abandoned before that cutoff is excluded permanently, matching "the engine has genuinely stopped watching it."
- **Reporting mechanism**: status mutation in place, not a new event/webhook concept. A re-watched Transaction that turns out to have confirmed or failed goes through the exact same `markConfirmed`/`markFailed` path `pollPendingTransactions` already uses (shared via a new `tryResolveByStatus` helper), so callers see it via the existing `GET /v1/dispatch/:id` polling — no new caller-facing surface, consistent with ADR-0023's webhook deferral. This is not a double-pay risk under ADR-0004: the rewatch is the mitigation for double-pay (it's what lets a caller who already resent after seeing ABANDONED discover the original also landed), not a new source of it, and an ABANDONED→FAILED transition still only fires off a definitive `getStatus === 'FAILED'`, never a guess.
- **Where it lives**: a wholly separate poll loop (`Coordinator.rewatchAbandonedTransactions` + `worker.ts`'s `rewatchLoop`), not a second branch inside `pollPendingTransactions` — keeps the two cadences independently tunable and neither loop has to know the other exists.

Implemented and reviewed (Standards + Spec) 2026-09-24; both axes came back clean on the implementation itself.
