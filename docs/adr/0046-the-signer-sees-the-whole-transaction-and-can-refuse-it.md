# The Signer sees the whole transaction, authenticates the engine, and can refuse

ADR-0002 put signing behind a network boundary so a compromised engine can't take the keys. On its own that only protects the key material, not the funds. On EVM the engine sends the Signer a 32-byte keccak hash, so the Signer can't tell what it is signing. And `/sign` has no authentication, so anything that can reach it gets signatures. A compromised engine, or any process on its network, can have any transaction signed.

## Decision

This amends ADR-0002's wire contract. The boundary itself is unchanged.

- **The whole unsigned transaction.** `POST /sign` takes `{ chain, curve, address, unsignedTransaction }`. `unsignedTransaction` (base64) is the chain's full unsigned transaction: on EVM the EIP-1559 unsigned serialization (`0x02 || rlp(...)`), which the Signer hashes itself; on Solana the serialized message, as before. The field is renamed from `unsignedTxBytes` on purpose, so a Signer on the old contract fails loudly instead of signing something it misreads. The response is unchanged: `{ signature }`, 65 bytes `r||s||recovery` on secp256k1 and 64 on ed25519.
- **Authentication.** Every request carries `Authorization: Bearer <SIGNER_AUTH_TOKEN>`. The Signer refuses to start without a token and answers `401` to a wrong one. mTLS can replace or join it later.
- **Policy.** The Signer may refuse a transaction it decodes as outside its policy, with `403 { error, reason }`. The engine maps that to a new error code, `SIGNER_REFUSED`. It is definite, the Call is `FAILED`, and it is never retried. Every other Signer failure stays `SIGNER_UNREACHABLE`.
- **The engine checks every signature.** Whatever the Signer returns must verify for the Sender's own address before the engine uses it: Base recovers the address, and Solana already verifies. A wrong key is caught before anything is sent.

## Consequences

- Breaking: the engine and its Signer must be upgraded together. Nothing is on mainnet yet, so there is no compatibility shim.
- The Signer now decodes transactions, so it depends on chain libraries (viem, @solana/web3.js). That is still outside the engine's dependency tree, as ADR-0002 requires.
- Policy covers what one transaction does. Limits across transactions, such as a daily cap, need state in the Signer and are not part of this decision.
