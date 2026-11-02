# Flag Rules are checked at submission and hold the whole Dispatch

Accepted 2026-10-31.

Operators want a human look at Dispatches that break their own expectations (a large amount, a new recipient, an unlisted contract) before anything is signed. These are Flag Rules, set from the web console (`.scratch/flag-rules/spec.md`).

## Decision

- **Checked in `POST /v1/dispatch`, after validation, for Managed Dispatch only.** A match stores the Dispatch as `held`, which the worker never claims. Release makes it `queued`; cancel works on it unchanged (ADR-0056), because it was never claimed. The rules read only the engine's own database, so this adds no RPC call to the ingest path that ADR-0024 kept the Funding Check off.
- **The whole Dispatch is held**, never some of its items, and the response names which items matched which rule.
- **Rules are versioned and forward-only.** An edit makes a new version; a hold records the version it matched. Editing or deleting a rule never re-checks or releases a Dispatch already held: a person decides each one.
- **No deadline.** Nothing is signed while held, so there is no blockhash or nonce to lose by waiting.
- **Relay Dispatch is never checked.** Its bytes belong to someone else's wallet, and holding them could let them expire.
- **A mistake-catcher, not a security control.** Rules live in the engine's database and are changed with the engine's operator token (ADR-0057). The hard limits belong in the Signer's policy (ADR-0046).

## Considered options

- **Check in the claim step, next to the Funding Check.** Rejected: a held Dispatch would already be claimed, so cancel would need an exception, and a held Dispatch would sit inside the Coordinator's in-flight state.
- **Hold only the matching items.** Rejected: a payment file half-sent while someone decides on the rest is harder to reason about than one that waits whole.
- **Refuse instead of hold.** Rejected: the Signer's policy already refuses, out of process and more strongly. A hold's value is that a person can say yes.
- **Re-check held Dispatches when rules change.** Rejected: a rule edit would silently release Dispatches nobody looked at.
