Status: blocked-by-relay-dispatch-01

# 15: Reliable delivery for externally-signed transactions

**What to build:** A Relay Dispatch transaction gets the same delivery reliability a Managed Dispatch transaction already has. A dropped send is retried automatically with the identical signed bytes. A transaction that's genuinely, provably dead (its blockhash has expired) resolves to a clean, definitive failure — the same guarantee Managed Dispatch already gives — instead of quietly degrading to "we're not sure" just because this handler never produced the signature itself.

**Blocked by:** relay-dispatch issue 01 (needs the real end-to-end pipe to exist to demonstrate this against)

**Status:** blocked-by-relay-dispatch-01

- [ ] `broadcast` derives blockhash bookkeeping from a signed transaction's own embedded `recentBlockhash` when it wasn't signed by this handler (no RPC needed — the blockhash is already public information in the signed bytes)
- [ ] `getStatus`'s provable-expiry-to-`FAILED` decision (ADR-0030) applies identically regardless of who signed the transaction
- [ ] A transient send failure is retried a small, bounded number of times with the identical signed bytes — never a new blockhash, never a new signature
- [ ] Each retry is recorded via the existing `DispatchStore.recordBroadcast` as a new Attempt of the same Transaction, never a new Transaction row
- [ ] Proven against real devnet (ADR-0013): a transaction signed by a keypair entirely outside this handler is held until its blockhash genuinely expires, confirming it resolves to `FAILED` — matching issue 08's existing proof for self-signed transactions, now shown to hold for one this handler never signed
