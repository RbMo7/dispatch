# A Dispatch can be cancelled only before it is claimed

Accepted 2026-10-31. Amends the `docs/api.md` status vocabulary.

The web console (`.scratch/web-console/spec.md`) gives operators one write action: cancel. Until now the engine had no way to withdraw a Dispatch, and `CONTEXT.md` listed "CANCELLED" only as a word to avoid for `ABANDONED`.

## Decision

- **`POST /v1/dispatch/:id/cancel`**, behind the same bearer token as the rest of `/v1` (ADR-0022). The console calls it like any other client.
- **Only a whole Dispatch, and only while it is unclaimed.** The cancel and the worker's claim are decided in one atomic update, so exactly one wins. A Dispatch the worker already claimed answers `409`, whatever its items' state.
- **`cancelled` is a new terminal status**, for every item and at the top level. It is stored, not derived, because nothing downstream ever existed to derive it from. Cancelling an already-cancelled Dispatch returns its current state, not an error.
- **Relay Dispatch can be cancelled under the same rule**: before it is claimed, its bytes were never broadcast.
- **An open Proposal is not cancellable by the engine.** Rejecting it is the Approvers' decision (ADR-0049); the console links to it in Squads or Safe instead.

## Considered options

- **Cancel individual items that have no Transaction yet** (a Multisig Sender's unproposed Calls, Calls queued behind an open Safe Proposal). Rejected for now: it means splitting a claimed Dispatch mid-plan, racing the Coordinator's Proposal planning, and a top-level status that mixes cancelled and sent items.
- **Cancel anything not yet confirmed.** Rejected: on Solana a sent transaction cannot be recalled; on Base it means paying for a same-nonce replacement, which ADR-0003 keeps off unless a caller opts in, and a Relay transaction has no key to replace it with.

## Consequences

- A caller polling `GET /v1/dispatch/:id` can now see `cancelled`; clients that switch on status need the new value.
- The window is short on a busy engine (the worker claims within seconds), so cancel mostly helps when the worker is stopped or behind. The flagged-Dispatch hold (if built) widens it.
