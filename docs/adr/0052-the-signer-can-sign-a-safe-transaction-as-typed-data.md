# The Signer can sign a Safe transaction as typed data

ADR-0046 made the Signer see the whole unsigned transaction instead of a hash, so it can refuse what it signs. A Safe proposal needs a signature the contract does not cover: the delegate signs the EIP-712 hash of a Safe transaction, which is not an EIP-1559 transaction. Sending the engine's own hash would bring back exactly the blind signing ADR-0046 removed.

## Decision

This extends ADR-0046's wire contract. Existing requests are unchanged.

- **A second request kind**, `POST /sign` with `kind: "safeTransaction"` and the full Safe transaction in place of `unsignedTransaction`: the Safe address, the chain ID, and `to`, `value`, `data`, `operation`, `safeTxGas`, `baseGas`, `gasPrice`, `gasToken`, `refundReceiver`, `nonce`. The response is the same `{ signature }`.
- **The Signer computes the EIP-712 digest itself** from those fields, then signs it with the same secp256k1 primitive it already uses for transaction digests, so every backend (`keyfile`, `local`, `privy`, `aws-kms`) works without new key handling. The engine verifies the signature recovers to its delegate address before using it, as it does for transactions (ADR-0046).
- **Policy applies to the decoded fields.** `allowedSafe` pins the Safe address; the chain ID must be in `chainIds`; `operation` must be a delegatecall to the canonical `MultiSendCallOnly`; and `safeTxGas`, `baseGas`, `gasPrice` and `refundReceiver` must be zero. Any other signing request for a key with `allowedSafe` is refused with the existing `403`, and a request of an unknown `kind` is refused with `400`.
- **A key without `allowedSafe` still answers this kind**, like any other request: with no policy it signs, still only for an authenticated caller (ADR-0046), and a policy without `allowedSafe` refuses it. The engine only sends the kind in Safe mode.

## Considered options

- **Send the digest, as the old EVM contract did.** Rejected: it is blind signing, the problem ADR-0046 solved.
- **A general EIP-712 signing endpoint.** Rejected: a key that signs arbitrary typed data can be made to sign a token permit or an order, so the Signer would need a policy for every typed-data schema. A named kind with one fixed schema keeps the policy checkable.
- **Make the executor key sign proposals as a normal transaction.** Rejected: the Safe Transaction Service needs a signature over the Safe transaction hash, not a transaction.

## Consequences

- Breaking only for a Signer that must serve Safe mode: an old Signer answers `400` to the new kind and the engine reports `SIGNER_UNREACHABLE` at startup rather than at the first Dispatch.
- The Signer gains Safe's EIP-712 domain and struct definitions, in `signer/` only, never in the engine (ADR-0002).
- The delegate key signs only a Safe transaction for the pinned Safe, so it cannot sign anything an attacker can reuse elsewhere, but it is the same key as the executor. A leaked key can propose to the Safe and spend the executor's gas; it cannot approve or move the Safe's funds.
