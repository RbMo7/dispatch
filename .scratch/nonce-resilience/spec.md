Status: decided 2026-11-01; ADR-0064 accepted; tickets below

# Nonce resilience: recover when another sender takes a nonce, and say so

ADRs: 0037, 0039, 0041, 0042, 0060; new 0064.

## Problem Statement

A Base Sender's nonce counter is seeded from the confirmed count at startup, then counts locally (ADR-0039). If anything else sends from the same wallet (a second engine, a wallet app, a script), the chain's nonce moves ahead, and the engine keeps signing nonces that are already used. The node answers "nonce too low", and the item fails with `NONCE_ALREADY_USED`, although the payment never happened and could simply be sent again. Nothing tells the operator that another sender exists.

The live flow run hit this on 2026-11-01, when two test engines shared one Base key.

## Solution

- **Recover.** When the node answers "nonce too low" for a transaction whose own hash never landed, that transaction can never land. The engine reads the chain's nonce, moves its counter forward, and sends the same Calls again as a new Transaction at the next free nonce. This is the same pattern as the Solana resend after expiry (ADR-0042), and it costs nothing extra, because the first transaction was never charged.
- **Detect.** The worker notices when the chain's nonce for a Sender moves past every nonce this engine has used. It records which nonces another sender took, and reports this in the logs, `doctor`, the Setup page and the Sender's card.
- **Document** the rule: one engine per Sender. To split work, use named Senders in one engine (ADR-0060).

## User stories

1. As an operator, I want a payment whose nonce was taken by another sender to go out anyway, at the next nonce, without me resubmitting it.
2. As an operator, I want to be told plainly that something else is sending from my Sender's wallet, and which nonces it used.
3. As an operator, I want the flow to show what happened ("Nonce 3124 was taken by another sender. Sent again with nonce 3127.").
4. As a developer reading the docs, I want to know that a Sender belongs to one engine, and how to split work instead.

## Design

### Recovery (ADR-0064)

- **Trigger.** A send or rebroadcast answered with "nonce too low" (or the equivalent "nonce has already been used") for a Transaction this engine signed.
- **Check first.** The engine asks the chain for a receipt for that Transaction's own hash, and for any earlier version of the same Call (fee-bump replacements). If one exists, that is the normal "it landed" path: confirm it. A receipt read that fails (an RPC error) leaves the item broadcasting and retries later, as for any ambiguous outcome. It is never treated as "not landed".
- **Otherwise:**
  - mark the version dropped, with reason `nonce_taken`;
  - read the chain's pending nonce for the Sender;
  - move the Sender's counter to at least that nonce;
  - prepare and sign the same Calls as a new Transaction. This is written before it is sent (ADR-0041). It keeps the same fees as the original, or the current estimate when Retry Policy allows repricing.
- **Limit.** At most 3 resends per Call for a taken nonce. After that the item fails with `NONCE_ALREADY_USED`, and its message says another sender keeps taking this wallet's nonces.
- **Scope.** Base only. Solana has no account nonce. Squads and Safe Proposals already handle a taken Safe nonce (`APPROVAL_REJECTED`, stale; ADR-0053), and that stays as it is.

### Detection

- **The check.** On each confirmation pass, the worker compares the chain's confirmed nonce count for every Base Sender with the highest nonce this engine has confirmed or has in flight. When the chain is ahead and no Transaction of ours explains the difference, those nonces were used by another sender.
- **Record.** `sender_foreign_nonces` stores one row per (Sender, nonce) the engine did not send, with the time first seen. The worker logs a warning once per new range.
- **Surfaces:**
  - A setup check, `sender.exclusive`: it warns when another sender used this wallet in the last 24 hours, and the fix tells the operator to stop the other sender or give this engine its own Sender.
  - `GET /v1/senders` gains `foreignActivity: { lastSeenAt, nonces: [first, last], count } | null`.
  - The console's Sender card shows a warning line, and Senders & Keys explains it.

### Console

- **Flow:** a resend for a taken nonce appears as a branch, "Nonce 3124 was taken by another sender. Sent again with nonce 3127.", which rejoins at the version that landed.
- **Sender:** the warning on the Sender card and on the Setup page.

## Out of scope

- Coordinating several engines over one wallet. That is unsupported, and the docs say so.
- Repricing beyond what Retry Policy already allows.
- Solana, which has no account nonce.

## Testing

- **Unit:** the decision table. A taken nonce whose hash landed, never landed, or can't be read. An earlier fee-bump version that landed. The resend limit.
- **Coordinator:** a fake Base chain whose nonce is advanced by an outside writer mid-batch. Every payment confirms, none is sent twice, and the counter ends at the chain's nonce.
- **Live:** two engines given the same Base Sepolia test key on purpose. Payments from both. Every payment confirms, the flow shows the resend, and both engines warn about the other.

## Proposed issues

1. Recovery: the "nonce too low" decision, counter re-seeding, resend as a new Transaction, the limit, and the timeline entry (ADR-0064).
2. Detection: foreign nonces recorded, the warning, the setup check, and `foreignActivity` on `/v1/senders`.
3. Console: the resend branch in the flow, and the warning on the Sender card, Senders & Keys and Setup.
4. Docs, plus the live two-engine run: "One engine per Sender" in Self-hosting and Errors, and `NONCE_ALREADY_USED` re-explained.
