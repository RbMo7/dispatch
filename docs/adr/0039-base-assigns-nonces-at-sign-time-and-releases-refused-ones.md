# Base assigns nonces at sign time, and releases one whose send was refused

Issues #2 and #3 assigned every nonce in `prepare`, up front, and the Coordinator then signed and broadcast each transaction in turn. Any failure after `prepare` leaked a nonce:

- the rest of the batch failing in `prepare` itself (e.g. an RPC outage on item 3);
- `sign` failing (e.g. the Signer is unreachable);
- the node refusing the broadcast.

Nothing was ever sent at the leaked nonce, so every later transaction from the Sender, in that batch and every later one, went out at a nonce that could never be mined, then sat until stuck handling and abandonment. One refused payment could stall the Sender (#24).

Now `prepare` leaves the nonce empty, and `sign` assigns it at the last moment. The counter hands a nonce back only if it's the most recently assigned one (`NonceCounter.release`):

- **`sign` fails:** the nonce is handed back straight away.
- **`broadcast` is refused definitively** (the node answered no: `CHAIN_REJECTED` or `INSUFFICIENT_FUNDS`, and not "already known"): the nonce is handed back too. This only applies to a nonce this handler assigned and hasn't sent before, so a rebroadcast of a transaction already in a mempool can never release its nonce.

A fee-bump replacement still carries its stuck predecessor's nonce explicitly. Because a single worker signs and broadcasts one transaction at a time, the refused nonce is always the most recent one, so releasing it is always safe.

Without a nonce in the unsigned bytes, two identical payments would encode identically, and the Coordinator groups identical bytes as one bundle. So every prepared transaction carries a unique `preparedId`, which one Bulk chunk's members share.

## Consequences

- **Ambiguous failures still leave a gap.** A broadcast that times out or loses its connection releases nothing: the transaction may have reached the node, and reusing its nonce could replace a real payment. Resolving that needs the broadcast-then-persist work in #20.
- **Scope.** This lives entirely inside `BaseChainHandler`: no Coordinator or interface change, and no extra cost (ADR-0003). The alternative of filling a gap with a zero-value self-transfer would cost gas.
- **Concurrency.** With more than one worker per Sender, "the most recent nonce" would no longer mean "the refused one". `release` would then correctly refuse, and a gap could form again. Sender Pool work (ADR-0016) would need to revisit this.
