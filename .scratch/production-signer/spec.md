Status: ready-for-agent

# Production Signer

## Problem Statement

The engine is ready to send on mainnet except for the keys. The only Signer is `reference-signer/`, which is for development:

- **It signs blind on EVM.** The engine sends a 32-byte keccak hash, so the Signer can't see what it signs, and no policy is possible.
- **Anyone who can reach it gets signatures.** `/sign` has no authentication.
- **Its keys are in a committed file** (`reference-signer/keys.dev.json`), held in process memory.
- **It can't sign for real addresses as shipped.** The keyfile is keyed by name (`"dev-sender"`), but the engine asks by address (`keyring[curve][address]`), so the Docker Compose stack's Managed Dispatch gets a 404 from the Signer. The live tests never noticed: each starts its own in-process signer keyed by address.
- **The engine trusts Base signatures it never checks.** Solana verifies the returned signature; Base serializes whatever comes back. A misconfigured Signer could sign with the wrong account.

## Solution

One Signer service, `signer/` (renamed from `reference-signer/`), with pluggable key backends: `keyfile` for development, `privy` (Privy server wallets) and `aws-kms` for production. The operator picks a backend per address in the Signer's config. It implements ADR-0046's contract:

- the whole unsigned transaction, not a hash;
- bearer-token authentication;
- a per-address policy it enforces on the decoded transaction, refusing with `403`;
- an audit log line for every request.

The engine sends the full transaction and the token, maps a `403` to the new error `SIGNER_REFUSED`, and verifies every signature against the Sender before using it.

## User Stories

1. As an operator, I want my keys in AWS KMS or Privy, never in a file or in process memory, so that a compromised host can't exfiltrate them.
2. As an operator, I want the Signer to refuse a transaction outside my policy (wrong chain, unknown destination, too much value), so that a compromised engine can't drain the Sender.
3. As an operator, I want only my engine able to request signatures, so that nothing else on the network can.
4. As an operator, I want every signing decision logged, so that I can audit what was signed and what was refused, and why.
5. As an integrator, I want a policy refusal reported as `SIGNER_REFUSED` with the Signer's reason, never retried, so that I know the payment was blocked on purpose.
6. As an operator, I want the Signer to check at startup that every configured key matches its address, so that a wrong key ID fails loudly before anything is signed.
7. As an operator, I want `docker compose up` to give me a working engine and Signer, so that the dev stack actually signs.
8. As a contributor, I want the engine to verify every signature it receives, so that a misbehaving Signer can't make it send from the wrong account.

## Implementation Decisions

- **Wire contract (ADR-0046).** `POST /sign {chain, curve, address, unsignedTransaction}` plus `Authorization: Bearer`. EVM: the unsigned EIP-1559 serialization, which the Signer keccak-hashes. Solana: the message bytes. Responses: `200 {signature}`, `400` malformed, `401` auth, `403 {error, reason}` policy, `404` unknown address, `5xx` failure.
- **Contract edge cases (#47, decided 2026-10-01).** Only a `403` with a `{ error, reason }` body is `SIGNER_REFUSED`; any other `403` stays `SIGNER_UNREACHABLE`. A refused Base fee-bump stops bumping (the original stays tracked); a refused Solana resubmission marks the expired original `FAILED`. An engine without `SIGNER_AUTH_TOKEN` starts with a warning.
- **Engine.**
  - `SignerClient` sends `SIGNER_AUTH_TOKEN` and maps `403` to `SIGNER_REFUSED`, a new `DispatchErrorCode` documented in `docs/api.md`.
  - The Base handler sends `serializeTransaction(tx)` and recovers the signer address; a mismatch is `SIGNER_UNREACHABLE` and the nonce is released.
  - A `SIGNER_REFUSED` from a Solana resubmission fails the Call; it is not retried every tick like an unreachable Signer.
- **Signer layout.**
  - `signer/src/server.ts` covers HTTP, auth and the audit log.
  - `policy.ts` decodes and checks transactions.
  - `backends/keyfile.ts`, `backends/privy.ts` and `backends/aws-kms.ts` share one `KeyBackend { address(curve, keyRef), sign(curve, keyRef, payload) }` interface. ADR-0012 allows it: there are three real implementations.
  - Config is one JSON file (`SIGNER_CONFIG`), mapping each address to `{ curve, backend, keyRef, policy? }`. At startup the Signer derives every address from its key and refuses to start on a mismatch.
- **Keyfile backend** derives addresses from the keys, which fixes the name-versus-address bug. It logs a loud warning that it is for development only.
- **Privy backend (#55).**
  - `keyRef` is a Privy server wallet id. Credentials: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, and optionally `PRIVY_AUTHORIZATION_KEY` (signs each request for wallets owned by an authorization key; the mainnet checklist requires it).
  - secp256k1: the `secp256k1_sign` RPC with the keccak digest (`raw_sign` is refused for Ethereum wallets); the 64-byte `r||s` is normalized to low-s and the recovery bit found against the wallet's address (a helper the KMS backend reuses).
  - ed25519: `rpc signTransaction` on the message wrapped in a transaction; the fee payer's signature is extracted from the result.
  - At startup each wallet's address is fetched and checked against the config.
- **AWS KMS backend.**
  - secp256k1: key spec `ECC_SECG_P256K1`, `Sign` with `MessageType: DIGEST` and `ECDSA_SHA_256`, so KMS signs the keccak digest as given. The DER result becomes `r,s`, normalized to low-s, and the recovery bit is found by recovering against the key's address. The address comes from `GetPublicKey`.
  - ed25519 for Solana (#51): supported. Key spec `ECC_NIST_EDWARDS25519`, `Sign` with `MessageType: RAW` and `ED25519_SHA_512`, which is pure Ed25519 (RFC 8032, FIPS 186-5 Section 7.6), what Solana verifies; never `ED25519_PH_SHA_512` (HashEdDSA over a digest). The signature must be 64 bytes (AWS documents it only as the FIPS 186-5 EdDSA signature, `R || S`) and is verified against the key's address over the message. The address is the base58 of the 32-byte key in the Ed25519 SubjectPublicKeyInfo. Source: the AWS KMS Developer Guide's key spec reference, https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html.
- **Policy v1** is per address and optional; with no policy, the Signer signs anything for that address, but still only with authentication.
  - `chainIds`: EVM chain IDs the key may sign for.
  - `allowedDestinations`: EVM `to` addresses, or Solana program IDs besides System, Token, Token-2022, Associated Token and ComputeBudget.
  - `maxNativePerTransaction`: wei or lamports, summed over the transaction's value, SystemProgram transfers and `aggregate3Value` values.
  - `maxTokenPerTransaction`: `{ tokenAddressOrMint: amount }`, from ERC-20 `transfer` and SPL `transferChecked`, including inside `aggregate3Value`.
  - Anything the decoder can't read is refused when a policy is set.
- **Audit log:** one JSON line per request with time, address, chain, transaction id, decision and reason. Never the payload's secrets; there are none, but no raw keys either.
- **Docker Compose** runs `signer/` with the keyfile backend, a dev token, and dev keys keyed by address. Mainnet docs say to replace all three.

## Testing Decisions

- **Signer, offline:** auth (missing or wrong token gives 401); the policy matrix (each rule allows and refuses; nested `aggregate3Value`; undecodable refused); the keyfile backend's address derivation; KMS and Privy against mocked clients (DER parsing, high-s normalization, recovery bit, Solana signature extraction, Privy authorization header, address mismatch at startup).
- **Engine, offline:** `SignerClient` 401, 403 and 5xx mapping; Base recovered-address mismatch refused with the nonce released; a `SIGNER_REFUSED` Call is `FAILED` and never retried.
- **Live (local, opt-in):** existing live tests keep passing on the new contract, since their in-process signers are updated too. `RUN_PRIVY=1` covers Privy wallets signing a Base Sepolia and a Solana devnet transaction that land; `RUN_AWS_KMS=1` covers a real KMS key signing a Base Sepolia transaction that lands, and with `AWS_KMS_ED25519_KEY_ID` an Ed25519 KMS key signing a Solana devnet transaction that lands. A Docker Compose smoke test runs engine plus Signer over HTTP with auth.

## Tickets

Worked in this order:

1. #47: contract v2 (whole transaction, auth, `SIGNER_REFUSED`, engine verifies signatures).
2. #48: rename to `signer/`, key backends, address-keyed config, audit log, a working Compose stack.
3. #55: Privy backend, both curves. Needs #48.
4. #50: AWS KMS secp256k1. Needs #48; reuses #55's recovery helper.
5. #49: policy v1. Needs #48.
6. #51: Ed25519 in KMS. KMS supports it, so the `aws-kms` backend signs for Solana too.
7. #52: runbook and mainnet checklist. Needs #49, #50, #51 and #55.

## Out of Scope

- Limits across transactions (daily caps), which need persistent Signer state.
- GCP KMS, Turnkey, Fireblocks and HSM backends: the same `KeyBackend` interface, added when someone needs one.
- mTLS, batch signing (ADR-0002 defers it), and key rotation tooling.
