Status: blocked-by-core-scaffold

# Broadcast, and blockhash-refresh-and-resubmit retry

Wire signing (via the Signer client from the scaffold — fetch a fresh blockhash immediately before requesting a signature, matching the reference implementation's timing discipline, since a blockhash fetched too early goes stale under batch volume) and broadcast. Then implement the retry behavior: if broadcast fails or the transaction doesn't confirm before its blockhash expires, refresh the blockhash and resubmit as a *new* Transaction (CONTEXT.md's Attempt-vs-Transaction distinction — this is a new Transaction, not a retried Attempt of the old one, since the signed bytes changed).

Test against real solana-devnet RPC (ADR-0013) — include a test at enough volume to actually exercise the blockhash-timing concern the reference implementation's comments describe, not just a single happy-path send.
