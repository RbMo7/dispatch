# Fee-bump is Coordinator-driven, via an optional Chain Handler method

A stuck EVM transaction only shows up while it's pending, and only the Coordinator's poll loop sees that phase, so the Coordinator decides when to act. The Chain Handler interface gains one **optional** method, `prepareReplacement(signed, senderAddress)`: given the latest signed bytes, it returns an unsigned transaction at the same nonce with both EIP-1559 fee fields raised to max(previous × (1 + `feeBumpPercent`), a fresh estimate). The Coordinator then runs the existing `sign` → `broadcast` pipeline and persists the result. The method is optional so no other Chain Handler changes. ADR-0015 flags interface changes made to add a chain, but Retry Policy is an engine-level concept (CONTEXT.md, ADR-0003), not a Base one, and handler-internal bumping (Solana's `broadcast`-time blockhash refresh pattern) can't work here: the Coordinator would never learn the new hash and would keep polling the dead original.

A chain opts in through a per-chain `{ stuckAfterMs, maxFeeBumps }` config; Base uses `{ 60s, 5 }`. A chain without that config (Solana) is never touched. For an opted-in chain, a transaction still pending `stuckAfterMs` after its latest broadcast is handled as follows:

- **Managed Dispatch with Retry Policy on:** the Coordinator bumps it. The replacement is a new Transaction row, one per member Call when bundled, pointing at its predecessor via `replacesTransactionId`. The predecessor becomes `REPLACED`: still watched, never shown as final.
- **Everything else** (Retry Policy off, or a Relay Dispatch): the Coordinator rebroadcasts the identical bytes as a new Attempt. That's free, and it's what CONTEXT.md already says Relay does.
- **Settling:** the latest version and every `REPLACED` ancestor are all checked, because any version at nonce N may be the one that lands. The first one to report `CONFIRMED` or `FAILED` settles the Call, and the others become `DROPPED`.
- **Bump cap:** at most `maxFeeBumps` attempts, counted by `feeBumpAttempts`, so failed attempts count too. After that, the normal abandonment timeout runs from the latest version's `broadcastAt`.
- **Bump failures:** `nonce too low` stops bumping (some version already landed), and the group is still watched. Any other failure, such as insufficient funds, is retried next tick against the cap. A bump failure never marks a Call `FAILED`.

Retry Policy on now suppresses abandonment only on a chain that can bump. Elsewhere it behaves like off; before, a stuck transaction was polled forever.

## Consequences

- **Crash window.** The broadcast-then-persist crash window of initial broadcast applies to replacements too: a crash between `broadcast` and the save can leave a landed replacement unknown to its Call. The nonce means no funds are at risk, only an `abandoned` report that is wrong. This is tracked as #20; `nonce_history` already holds the recovery data.
- **One stuck nonce stalls the Sender.** With Retry Policy off, one underpriced transaction blocks every later nonce from its Sender until it lands on its own. That's a known cost of "off", and the Sender Pool's argument.
- **No absolute fee ceiling yet.** Only the bump count bounds cost. Add a ceiling when a chain with volatile fees (Ethereum L1) needs one.
- **Changing `transactionHash`.** The API's `transactionHash` is the version that landed, or the latest one while bumping, so it can change between polls.
- **Reorg after a multi-version settle.** When a Call has been settled by one version, the reorg safety net (ADR-0036) only re-checks that version. The others are already `DROPPED`, so if a reorg removes the winner and a *different* version lands instead, the Call ends up `ABANDONED` rather than reporting the version that landed. This needs a reorg on Base *and* a fee-bumped Call; fix it (revert `DROPPED` siblings to `REPLACED` on reopen) if it's ever seen.
- **Every send restarts the stuck timer.** A refused rebroadcast (for example "already known") is still recorded as an Attempt, with its error. That restarts the stuck timer, so a stuck transaction is resent at most once per `stuckAfterMs`, and a failed bump waits a full `stuckAfterMs` before the next attempt.
