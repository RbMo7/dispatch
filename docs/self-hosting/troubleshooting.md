# Troubleshooting

Find the symptom you see, then the cause and the fix. Messages in `code font` are what the engine, the worker or the Signer actually prints.

Start with `pnpm dispatch doctor`. It checks the configuration, the database, each chain's RPC, the Signer, the balances and any multisig at once, and prints the fix for each problem. [Setup checks](./doctor.md) lists every check.

## The engine will not start

The API and the worker read the same settings and load the same chains, so both fail the same way. The error is the last line before the stack trace.

| Message | Cause | Fix |
| --- | --- | --- |
| `ENABLED_CHAINS names an unknown chain: "ethereum" …` | A typo, or a chain that is not built | Use `base`, `solana`, or both, comma-separated |
| `not a well-formed EVM address:` with nothing after it | `base` is enabled but `BASE_SENDER_ADDRESS` is empty | Set the Sender address, or `BASE_SAFE_EXECUTOR_ADDRESS` in Safe mode |
| `BaseChainHandler configured for chain ID 8453 but https://sepolia.base.org answered eth_chainId 84532 …` | `BASE_CHAIN_ID` and `BASE_RPC_URL` point at different networks | Set `BASE_CHAIN_ID=84532` for Sepolia or `8453` for mainnet, matching the RPC |
| `BASE_KNOWN_TOKENS entry "USDC:0x036C…CF7e" is malformed …` | A token entry missing a part | Write each token as `SYMBOL:address:decimals` |
| `invalid Solana multisig sender config` or `invalid Safe sender config` | A multisig setting is missing or bad. Every problem is listed. | See [Squads](./multisig.md#read-the-squads-startup-checks) or [Safe](./multisig.md#read-the-safe-startup-checks) |
| `startup checks failed` with `[check name]` lines | A Multisig Sender check failed | The [Squads](./multisig.md#read-the-squads-startup-checks) and [Safe](./multisig.md#read-the-safe-startup-checks) runbooks map each check to its cause |

A warning, not an error: `SIGNER_AUTH_TOKEN is unset: the Signer will refuse every signing request with 401 (a Relay-only deployment can ignore this)`. Set the token unless the engine only relays.

## The Signer will not start

It prints `signer refused to start:` and the problem, then exits with code 1. [Read the startup checks](./signer.md#read-the-startup-checks) lists every message, from `SIGNER_CONFIG is required` to `these addresses don't match their keys:`.

## The API refuses a request

| Status | Cause | Fix |
| --- | --- | --- |
| `401 { "error": "unauthorized" }` | The `Authorization` header is missing, or its token is not `AUTH_TOKEN` | Send `Authorization: Bearer <AUTH_TOKEN>` |
| `400 { "error": "Idempotency-Key header is required" }` | No `Idempotency-Key` | Send one with every `POST /v1/dispatch` |
| `400` with `CHAIN_NOT_ENABLED` | The chain is not in `ENABLED_CHAINS` | Enable it and restart the API and the worker |
| `400` with `UNKNOWN_ASSET` | The token is not an enabled Known Asset | Add it with `POST /v1/assets`, no restart needed, or list it in the variable as `SYMBOL:address:decimals` and restart |
| `400 { "error": "items[0]: amount must be a non-negative integer string" }` | A decimal amount such as `"12.5"` | Send the amount in the asset's smallest unit: `"12500000"` for 12.5 USDC |
| `413` with `FST_ERR_CTP_BODY_TOO_LARGE` | The body is over 1 MiB, about 9,000 payment items | Split the run into several Dispatches |
| `404 { "error": "not found" }` | No Dispatch has this id | Check the id, and that you are asking the same engine |
| `409` with `ALREADY_CLAIMED` | Cancel came after the worker claimed the Dispatch | Nothing to do: it is being sent. See [Cancel a Dispatch](../guides/cancel.md). |

[Errors](../errors.md) lists every code, and [Create a Dispatch](../openapi.yaml#create-a-dispatch) shows each `400` with its real message.

## A Dispatch stays `queued`

Nothing has claimed it. The worker is not running, is pointed at a different database, or does not serve the chain. Check that the worker is up, that its `DATABASE_URL` matches the API's, and that the chain is in its `ENABLED_CHAINS`. The worker logs `worker started` with its chains when it starts, and `claimed queued dispatches` each time it picks work up.

Every chain with transactions in flight must stay in `ENABLED_CHAINS`. Removing a chain while one of its transactions is `PENDING` stops confirmation tracking for every chain until issue #57 is fixed.

For a Multisig Sender, `queued` also means waiting for a Proposal. On Base it waits behind an earlier Proposal on the same Safe ([below](#multisig-sender)).

## An item is `failed`

Read `error.code`. Nothing that failed before signing was sent, so after you fix the cause, send the payment again with a **new** `Idempotency-Key`. The old key returns the old Dispatch.

- **`INSUFFICIENT_FUNDS`.** The payer cannot cover it. `chainDetail.short` is the shortfall in the smallest unit. Top up the payer. On Solana remember fees and new token-account rent ([Funding Check](../lifecycle.md#the-funding-check)).
- **`SIGNER_REFUSED`.** The key's policy refused the transaction. The message is `signer refused: <reason>`, with the same reason as the Signer's audit line. Fix the policy or the request. It is never retried.
- **`SIGNER_UNREACHABLE`.** The worker could not get a usable signature. The message names the cause: [Troubleshoot from the engine's side](./signer.md#10-troubleshoot-from-the-engines-side) maps each one.
- **`CHAIN_REJECTED`.** The chain refused or reverted it. `message` has the node's words, and `chainDetail` the raw detail, such as revert data.
- **`RPC_UNAVAILABLE`.** The RPC timed out, rate-limited or returned a 5xx. Public endpoints rate-limit, so use your own RPC provider for real traffic.
- **`NONCE_ALREADY_USED`.** Something else keeps sending from the Base Sender: a second engine, a wallet app or a script. The engine sends a payment whose nonce was taken again with a fresh nonce, up to 3 times, and fails it only after that. Nothing was paid. See [Another sender uses a Sender's wallet](#another-sender-uses-a-senders-wallet).

## Another sender uses a Sender's wallet

The `sender.exclusive` check warns, the Sender's card in the console says "Another sender used 3 nonces, 3124 to 3126", or a Dispatch's Flow tab shows "Nonce 3124 was taken by another sender". Something other than this engine sent from the Base Sender's address in the last 24 hours, and the warning names the nonces it used.

Each payment whose nonce was taken was sent again with a fresh nonce, so it is paid once. Payments can land out of order, and a payment whose nonce is taken 3 times fails with `NONCE_ALREADY_USED`.

1. Find what else holds the key: a second engine with the same `BASE_SENDER_ADDRESS` or senders file entry, a wallet app, or a script.
2. Stop it, or give it a key of its own. To split work, use [named Senders](./configuration.md#one-engine-per-sender) in one engine.
3. Send again any payment that failed with `NONCE_ALREADY_USED`, with a new `Idempotency-Key`.

The warning clears 24 hours after the last nonce another sender used.

## An item stays `broadcasting`

The transaction is sent and not settled yet. That is normal for a few seconds.

- **On Base,** after 60 seconds (`BASE_STUCK_AFTER_MS`) the engine resends the same bytes, or fee-bumps them if the Dispatch has Retry Policy on. After 15 minutes with no answer the item becomes `abandoned`. A Base network fee spike is the usual cause. [Retry Policy and stuck transactions](../lifecycle.md#retry-policy-and-stuck-transactions) explains both paths.
- **On Solana,** the engine resends until the blockhash expires, then rebuilds the transaction, up to 3 times. A congested network is the usual cause. Set a priority fee with `SOLANA_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS`.
- **An RPC that does not answer** keeps items `broadcasting`, because the engine will not call a send failed that it cannot prove failed. Check the worker's log for RPC errors.

## An item is `abandoned`

The engine stopped waiting without a definite answer, and the payment may still happen. **Do not send it again blindly.** Look the hash up in an explorer, or the Proposal in the multisig's app, first. The engine keeps checking for a while and updates the item if it lands ([The Dispatch lifecycle](../lifecycle.md#failed-and-abandoned-are-different)).

## The console shows no data

The console reads the same API with the token you sign in with, so the token must be the engine's `AUTH_TOKEN`. The sidebar shows "Reconnecting" while polling fails, usually because the API process stopped. [The web console](./console.md) has more.

## Multisig Sender

**The worker will not start.** Read the lines after `startup checks failed`. The tables in [Squads](./multisig.md#read-the-squads-startup-checks) and [Safe](./multisig.md#read-the-safe-startup-checks) map each check to its cause. A config error names the variable.

**`SIGNER_REFUSED` on a proposal or an execute.** The Signer's policy refused it. The message carries the reason, and so does the Signer's audit line. Usual causes: `allowedMultisig` or `allowedSafe` pins a different address than the engine's, `chainIds` lacks the chain, `allowedDestinations` is set and lacks the Squads program or the Safe, or the Safe's version uses a MultiSendCallOnly address that `allowedMultiSend` does not list. The Call fails and is never retried.

**`SIGNER_UNREACHABLE`.** As in [Troubleshoot from the engine's side](./signer.md#10-troubleshoot-from-the-engines-side). The proposal is left to retry.

**`INSUFFICIENT_FUNDS` for a Multisig Sender.** Read `chainDetail.holder`: `vault` or `memberKey` on Solana, `safe` or `executor` on Base. `address` is the balance to top up and `short` is the extra it needs, `committed` included. `committed` can be large because of timed-out proposals ([after a timeout](./multisig.md#what-the-engine-does-and-does-not-do-after-a-timeout)). Top up that balance, then send the Dispatch again with a new `Idempotency-Key`.

**`CHAIN_REJECTED` from the service or at proposal time.** A Call the multisig cannot hold (see the two runbooks), or on Safe a refusal from the Transaction Service. A 422 means the executor is probably not a registered delegate, or the signature does not match. A 401 means the API key is wrong or missing.

**An item stays `awaiting_approval` and nothing moves.**

1. Check `approval.approvals` and `threshold`. Usually nobody has voted. Ask the Approvers, and remember the `deadline`.
2. On Safe, open the Safe app. If the proposal is not there, the engine could not post it. The items are `awaiting_approval` anyway, because the proposal is written down first. The worker logs `proposal written down but not confirmed sent; left noted` and retries until the deadline, then abandons the Calls. The usual cause is a removed delegate registration (422), a wrong API key (401), or an unreachable service.
3. If the votes are in and it still does not execute, read the worker's log for `readProposal failed; backing off`, `prepareExecution failed` or `execute failed but the proposal can still execute`. On Solana a time lock that has not run is tried again later. On Safe, a Safe nonce that does not match, or fewer readable valid confirmations than the threshold (for example a confirmation from a key that is no longer an owner), is retried.
4. The worker must be running with the chain in `ENABLED_CHAINS`. Only the worker watches proposals.

**An item is `queued` for a long time on Base.** Another proposal holds the Safe. Its owners have not decided, or it is waiting out its deadline. The queue holds whole Dispatches, so look at the earlier Dispatch's items.

**An item is `abandoned` with `APPROVAL_TIMEOUT`.** See [after a timeout](./multisig.md#what-the-engine-does-and-does-not-do-after-a-timeout). Check the chain before sending again.

**`GS013` in a log or error on Safe.** The inner transfers cannot succeed as built, usually because the Safe lacks the balance. The proposal can never succeed as it is. Fund the Safe, or have the owners reject it.

**The multisig changed after startup.** The startup checks run once, when the worker starts. After you change the members, permissions or owners, restart the worker so they run again.
