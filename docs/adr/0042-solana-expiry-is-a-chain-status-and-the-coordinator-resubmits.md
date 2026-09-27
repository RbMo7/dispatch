# Provable expiry is its own chain status, and the Coordinator resubmits

Solana's `broadcast` used to re-sign an expired transaction with a fresh blockhash and send it, all inside one call. The new version was never written down before it was sent, which ADR-0041 exists to forbid: a crash, or an ambiguous send failure after the re-sign, left the row on the dead original while the new version could land (ADR-0041's two Solana caveats). A Call could then read `abandoned` or `failed` although it was paid, inviting a double payment. ADR-0037 already rejected handler-internal replacement for EVM for the same reason.

## Decision

- `ChainStatus` gains `EXPIRED`: the transaction provably can never land. Solana reports it once the blockhash has passed its validity window with no status recorded (ADR-0030's proof, made safe for mainnet by ADR-0045). A chain without such a proof never reports it.
- On `EXPIRED`, the Coordinator resubmits a Managed Dispatch's Calls: it re-`prepare`s the stored Calls of every pending row sharing the hash, signs, and writes the new Transaction down (`createReplacementTransaction`) before sending. The predecessor is marked `DROPPED` right away, since it can never land. No new handler method: re-preparing the Calls is enough.
- At most 3 resubmissions, counted by the replacement counter. After that, and always for a Relay Dispatch (no key), the Call is `FAILED`, which is what ADR-0030 reports.
- Resubmission does not need Retry Policy. An expired Solana transaction was never included, so it was never charged: resubmitting costs no more than the original was authorized to (ADR-0003). Raising the price on resubmission would be cost-increasing and would need Retry Policy.
- `broadcast` no longer re-signs. It resends the identical bytes every 2s while it waits, and on expiry returns the same hash for the Coordinator to act on.
- The worker's restart hook `reserveNonces` becomes `restoreInFlight`: Base still reserves nonces from the in-flight signed bytes, and Solana re-learns their blockhashes, so expiry stays provable after a restart.

## Consequences

- ADR-0041's two Solana caveats ("Solana after a crash" and "re-sign and then an ambiguous failure") no longer apply.
- A Solana Call can now have `DROPPED` predecessors that no other version settled; `DROPPED` means "can never land" in both cases.
- The Chain Handler interface changed (ADR-0015), but for an engine-level concept, a proof that a transaction is dead, not a Solana special case.
- A resubmission blocked by an unreachable Signer is retried every tick until it comes back. The original can't land meanwhile, so nothing is lost.
