# Solana's broadcast/getStatus derive blockhash bookkeeping from externally-signed transactions too

Issues 05–08 built `SolanaChainHandler.broadcast`'s retry-on-expiry and `getStatus`'s provable-expiry-to-`FAILED` decision (ADR-0030) against an implicit assumption that never had to be stated at the time: the transaction being broadcast was always one this handler itself signed, via its own `sign`/`signInstructions`, which is the only place `blockhashByHash` was ever populated. That held for every case those issues tested against, because Managed Dispatch is the only caller that existed.

Designing Relay Dispatch surfaced the gap: a transaction it hands to `broadcast` was signed entirely outside this handler, so there's no `blockhashByHash` entry for it. As written, `broadcast` would silently fall back to its "no bookkeeping for these bytes" bare-send path — issue 05's original scope, meant for the conformance suite's synthetic fixtures, never intended for real traffic — and `getStatus` would silently fall back to the Coordinator's generic timeout instead of the clean, provable `FAILED` ADR-0030 established. A Relay Dispatch transaction would get quietly worse reliability than a Managed Dispatch one, for a reason no caller could see or was ever told about.

`broadcast` now decodes any signed bytes it receives with no existing cache entry and populates `blockhashByHash` from the transaction's own embedded `recentBlockhash` before proceeding — no RPC needed, since a blockhash is public information already present in the signed bytes themselves; this handler never needed to have produced the signature to read it. `broadcast`'s and `getStatus`'s existing logic then applies completely unchanged for either origin.

## Consequences

`sign`-produced and externally-supplied signed transactions now get identical retry-on-expiry and provable-`FAILED` treatment. This is flagged as its own ADR per this repo's own rule (AGENTS.md: revise a decision explicitly rather than silently deviate) since it changes behavior in already-implemented, already-reviewed code (issues 05–08), even though the fix itself is narrowly scoped and adds no new interface surface.
