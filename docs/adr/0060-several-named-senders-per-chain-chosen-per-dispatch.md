# Several named Senders per chain, chosen per Dispatch

Accepted 2026-11-01. Amends the one-Sender-per-chain shape that every chain handler, the Coordinator and `GET /v1/senders` assume today.

An application can need both: routine payouts sent straight away from a hot wallet, and treasury transfers that wait for a multisig's Approvers. With one Sender per chain, that choice is all or nothing per chain. Spec: `.scratch/named-senders/spec.md`.

## Decision

- **An operator configures several Senders per chain**, each named, each with its own key, signing mode (plain, Squads or Safe), balances and nonces. One per chain may be the default.
- **A Managed Dispatch names its Sender** with an optional `sender` field. Without it the chain's default Sender pays, so existing callers are unaffected. Relay Dispatch has no Sender and refuses the field.
- **A Dispatch stores the Sender's address.** The address is the identity; the name is a label from configuration, so renaming keeps history.
- **The unit of execution is the Sender.** The Chain Registry holds one handler per (chain, Sender) sharing the chain's RPC. Claiming, the Funding Check, nonces, bundling, Proposals and concurrency are all per Sender, so one Sender's stuck transaction or open Proposal never delays another.

## Considered options

- **A `sender` parameter threaded through each Chain Handler method.** Rejected: every handler, its approval capability and its startup checks assume one Sender; threading a parameter through all of them spreads the change everywhere and invites a call that forgets it. One handler instance per Sender keeps each handler unchanged inside.
- **Sender Pool (ADR-0016).** Not this: a pool spreads one Dispatch automatically across interchangeable Senders for fault isolation. Named Senders are an explicit, per-request choice between Senders that differ in kind. The pool stays deferred and can later be built on top (a pool is a group of named Senders).
- **Choose the Sender by rule (amount, recipient).** Rejected for now: callers already know which kind of payment they are making, and Flag Rules cover "hold this if it looks unusual".

## Consequences

- One migration adds `sender_address` to Dispatches, backfilled from each chain's current Sender.
- `GET /v1/senders` returns one entry per Sender; Dispatch reads gain `sender: { name, address }`.
- With one API token (ADR-0022) any caller can choose any Sender; a Sender's Signer policy still bounds what it can sign.
