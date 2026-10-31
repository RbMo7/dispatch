# Retry Policy and stuck transactions

A transaction that was sent but does not confirm is stuck. The engine always keeps trying to deliver it. Retry Policy decides one thing on top of that: whether the engine may **pay more** to get it through.

## Off by default

Retry Policy is off unless you turn it on ([ADR-0003](../adr/0003-cost-increasing-behavior-defaults-off.md)). With it off, nothing about a Dispatch can cost more than what the transaction was signed with. A stuck transaction is resent with its identical bytes, never repriced.

Turn it on for one Dispatch in the request:

```json
{ "chain": "base", "retryPolicy": true, "items": [ … ] }
```

Or make it the default for every Dispatch that does not say, with `DEFAULT_RETRY_POLICY=true` on the API. The value is fixed when the Dispatch is created. Changing the default later does not change Dispatches already stored.

Retry Policy means nothing for a Relay Dispatch, where the engine has no key to sign a replacement, so a Relay request that sets it is refused.

## On Base: rebroadcast or fee bump

A Base transaction counts as stuck when it is still pending 60 seconds after its latest send (`BASE_STUCK_AFTER_MS`). Then:

- **Retry Policy off.** The engine sends the same signed bytes again. If the node already has them, that is fine. It keeps doing this until the transaction lands, or until 15 minutes pass with no answer, when the item becomes `abandoned`.
- **Retry Policy on.** The engine signs a replacement at the same nonce with both fees raised by at least 15% (`BASE_FEE_BUMP_PERCENT`), up to 5 bumps per Call (`BASE_MAX_FEE_BUMPS`), counting failed attempts ([ADR-0037](../adr/0037-fee-bump-is-coordinator-driven-via-an-optional-handler-method.md)). Only one version can ever be mined, because they share a nonce. When it runs out of bumps, the latest version waits out the same 15-minute timeout.

While a fee bump is in progress, the item's `transactionHash` is the latest version and can change between polls. Once one version lands, `transactionHash` is the one that landed, which may be the original. The [timeline](../api/get-dispatch.md#see-every-step-with-includetimeline) shows each version: `written` with `replaces`, `replaced` with `by`, and `dropped` for the versions that lost.

Each bump goes through the Signer like any transaction, so a policy cap applies to it. A refused bump stops the bumping, and the engine keeps tracking the transaction it already has.

## On Solana: resend, then resubmit

Solana has no fee bump and does not use Retry Policy. A Solana transaction carries a recent blockhash and is valid only until a known block height:

1. While the blockhash is valid, the engine resends the identical bytes.
2. Once the chain has passed that height, with a margin for a lagging RPC node, the transaction provably can never land ([ADR-0045](../adr/0045-solana-expiry-is-proven-by-block-height-with-a-lag-margin.md)). The engine then builds a new transaction for the same Calls with a fresh blockhash, signs it and sends it. The expired one was never charged, so this costs nothing extra ([ADR-0042](../adr/0042-solana-expiry-is-a-chain-status-and-the-coordinator-resubmits.md)).
3. After 3 resubmissions the item is `failed`.

A resubmission is a new transaction with a new hash, so `transactionHash` changes. An expired Relay Dispatch is `failed` straight away, because the engine cannot re-sign it.

To get through a congested network, set a priority fee instead: `SOLANA_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` as a fixed price, or `auto` with a ceiling in `SOLANA_MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS`. It is off by default for the same reason Retry Policy is ([Configuration](../operations/configuration.md#solana)).

## Resends are not new transactions

Sending the same bytes again is an **Attempt** of the same transaction. The timeline shows each one as `attempt`, with the node's error if it refused. Anything that changes the bytes, a fee bump or a fresh blockhash, is a new transaction with its own hash and its own `written` entry.
