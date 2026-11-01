# A Base transaction whose nonce another sender took is sent again

Accepted 2026-11-01. Amends ADR-0039 (what a "nonce too low" answer means) and builds on ADR-0042's resend pattern.

When something other than this engine sends from a Base Sender's wallet, the chain's nonce moves ahead of the engine's counter, and the engine's next transactions are refused as "nonce too low". Until now that failed the item with `NONCE_ALREADY_USED`, although nothing had been paid. Spec: `.scratch/nonce-resilience/spec.md`.

## Decision

- "Nonce too low" for a transaction whose own hash (and every earlier version of the same Call) has no receipt means that transaction can never land. The engine marks it dropped, moves the Sender's counter to the chain's pending nonce, and sends the same Calls again as a new Transaction, written down first (ADR-0041).
- A receipt read that fails is ambiguous, and the item stays broadcasting; only a definite "no receipt" allows the resend.
- At most 3 resends per Call; then the item fails with `NONCE_ALREADY_USED`, saying another sender keeps taking the nonces.
- The worker also records nonces the chain shows were used by someone else, and reports them; one engine per Sender remains the rule.

## Considered options

- **Keep failing the item.** Rejected: the payment provably did not happen, and failing it pushes a manual resubmission onto the caller for no safety gain.
- **Read the chain's nonce before every signature.** Rejected: an RPC call per transaction, and it still races an outside sender between the read and the send.
- **A lock shared between engines.** Rejected: the engines share no database by design, and a wallet app or script would never take the lock anyway.

## Consequences

- Payments survive an outside sender, but they can land in a different order from submission.
- A Sender used by two engines now degrades to slower, warned operation instead of failed items; it is still unsupported.
