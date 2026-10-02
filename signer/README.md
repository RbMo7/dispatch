# The Signer

The Signer holds each Sender's key and answers the engine's `POST /sign` (ADR-0002, ADR-0046). It is its own package: the engine never imports it, and vendor SDKs live only here.

This is the reference. To set up and run a production Signer, follow [`docs/signer.md`](../docs/signer.md), the runbook and mainnet checklist.

## Configuration

Environment variables:

- `SIGNER_AUTH_TOKEN` (required). The bearer token the engine sends. The Signer refuses to start without one.
- `SIGNER_CONFIG` (required). The path to a JSON file mapping each address to where its key lives.
- `PORT`. Defaults to 8421.
- Each backend's own variables, below. Only the backends `SIGNER_CONFIG` names are built, so an unused backend needs none of its variables.

`SIGNER_CONFIG` maps each address to a curve, a backend and a `keyRef` naming the key inside that backend:

```json
{
  "<the Privy wallet's EVM address>": {
    "curve": "secp256k1",
    "backend": "privy",
    "keyRef": "<Privy wallet id>"
  },
  "3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe": {
    "curve": "ed25519",
    "backend": "keyfile",
    "keyRef": "dev-sender"
  }
}
```

Backends can be mixed in one Signer. At startup the Signer asks each backend for the address behind each `keyRef`, and refuses to start if any differs from the address it is configured under.

Every request is audited as one JSON line on stdout.

## Policy

An address may carry a `policy`. The Signer then decodes each transaction before signing it and refuses one that breaks a rule, with `403 { "error": "policy refused", "reason": "..." }`. The engine reports that as `SIGNER_REFUSED`, with the reason in the message, and never retries it. The audit line records the decision as `refused`, with the same reason. An address without a policy is signed for unconditionally, though still only for a caller with the bearer token.

Every rule is optional, and each is checked on its own. Amounts are decimal strings in base units (wei or lamports, or the token's smallest unit), since JSON numbers can't hold them exactly. An unknown rule, a bad address or a bad amount stops the Signer at startup, so a misspelled rule never goes silently unenforced.

A Base Sender that may only pay two recipients and USDC, up to 0.01 ETH and 500 USDC per transaction:

```json
{
  "0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A": {
    "curve": "secp256k1",
    "backend": "aws-kms",
    "keyRef": "<key id>",
    "policy": {
      "chainIds": [8453],
      "allowedDestinations": [
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222"
      ],
      "maxNativePerTransaction": "10000000000000000",
      "maxTokenPerTransaction": { "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": "500000000" }
    }
  }
}
```

A Solana Sender that may use no program beyond the default ones, up to 1 SOL and 500 USDC per transaction:

```json
{
  "3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe": {
    "curve": "ed25519",
    "backend": "privy",
    "keyRef": "<wallet id>",
    "policy": {
      "allowedDestinations": [],
      "maxNativePerTransaction": "1000000000",
      "maxTokenPerTransaction": { "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "500000000" }
    }
  }
}
```

### Rules

- `chainIds` (EVM only). The transaction's chain id must be listed. A transaction without one is refused. Setting it on an `ed25519` address is a config error.
- `allowedDestinations`.
  - EVM. The transaction's `to` must be listed, and so must the `target` of every call inside an `aggregate3Value` (the engine's Bulk Call), at any depth. A contract creation has no `to` and is refused. Addresses compare case-insensitively. A Bulk Call needs both its aggregator and every item's target listed. A Payment in a token needs the token contract listed, not the recipient.
  - Solana. Every instruction's program must be listed, except the ones every payment uses: System, Token, Token-2022, Associated Token and ComputeBudget. An empty list therefore allows plain SOL and SPL payments and nothing else. It does not restrict who receives SOL or tokens; cap the amounts for that.
- `maxNativePerTransaction`.
  - EVM. The larger of the transaction's `value` and the sum of the values its `aggregate3Value` calls forward. Multicall3 requires the two to be equal, but an aggregator the caller names might not, so the larger counts, and the two are never added together.
  - Solana. The lamports of every System `Transfer`, `TransferWithSeed`, `CreateAccount`, `CreateAccountWithSeed` and `WithdrawNonceAccount`, summed. Other System instructions move no lamports and are allowed. Rent paid for an account created through another program, such as the Associated Token program creating a recipient's token account, is not counted.
- `maxTokenPerTransaction`, keyed by token contract address (EVM) or mint (Solana).
  - EVM. ERC-20 `transfer(address,uint256)` calls to a capped token, at the top level or inside `aggregate3Value`, summed per token. Any other call to a capped token (`approve`, `transferFrom`, an unknown function) is refused, since it could move the token without being counted. Tokens without a cap are not looked at.
  - Solana. `TransferChecked` instructions (Token and Token-2022), summed per mint. While any token cap is set, every other Token or Token-2022 instruction (`Transfer`, which names no mint, `Approve`, and the rest) is refused for the same reason, as is a `TransferChecked` in a v0 message whose mint comes from an address lookup table, which the Signer can't resolve offline.

With a policy set, a transaction the Signer can't read is refused, and the reason names what it couldn't read: bytes that aren't a transaction, an EVM transaction type other than legacy, EIP-2930 or EIP-1559, malformed `aggregate3Value` or `transfer` calldata, System instruction data that doesn't parse, or a Solana message with bytes left over after decoding. An empty `policy: {}` has no rules, but still refuses what it can't read.

Limits are per transaction only. The engine bundles several Payments into one transaction (one Bulk Call chunk on Base, up to a full message on Solana), so a cap applies to a whole bundle, and a batch larger than the cap is refused. A limit across transactions, such as a daily cap, needs state in the Signer and is out of scope.

An allowed destination is trusted with whatever it does next. The Signer looks inside `aggregate3Value` and refuses Multicall3's other batch functions (`aggregate`, `aggregate3`, `tryAggregate`, `blockAndAggregate`, `tryBlockAndAggregate`) whenever a policy is set, since their inner calls go unread. Any other function of a listed contract can still make calls the policy never sees, so list only contracts you trust that far.

## Backends

### `keyfile`

For development only. It reads raw private keys from a JSON file, `{ "secp256k1": { "<keyRef>": "<hex>" }, "ed25519": { "<keyRef>": "<hex seed>" } }`, and warns at startup.

- `SIGNER_KEYFILE`: the file's path.

`keys.dev.json` and `signer.config.dev.json` are the committed dev keys and their config, which Compose and `pnpm dev` use.

### `privy`

Keys held by Privy server wallets. The private key never leaves Privy; the Signer holds only API credentials. `keyRef` is the Privy wallet id. An Ethereum wallet signs for `secp256k1`, a Solana wallet for `ed25519`.

- `PRIVY_APP_ID`, `PRIVY_APP_SECRET`: the app's API credentials.
- `PRIVY_AUTHORIZATION_KEY` (optional, recommended): the private key of a Privy authorization key, as Privy shows it (`wallet-auth:...`). When set, every signing request is signed with it.

Make each wallet owned by the authorization key and set `PRIVY_AUTHORIZATION_KEY`. Privy then refuses to sign for the wallet unless the request carries that key's signature, so leaked app credentials alone can't sign. Without an owner, the app secret alone is enough. [`docs/signer.md`](../docs/signer.md#privy) shows how to create owned wallets, and its mainnet checklist requires them.

On `secp256k1` the Signer asks Privy to sign the transaction's keccak256 hash (the `secp256k1_sign` RPC; Privy refuses `raw_sign` for Ethereum wallets), lowers a high `s` and finds the recovery bit against the wallet's address. On `ed25519` it sends the Solana message to Privy as an unsigned transaction (`signTransaction`), so Privy's own transaction policies still apply. Either way, a signature that doesn't verify for the wallet's address is never returned.

### `aws-kms`

Keys held in AWS KMS, for both curves: a secp256k1 key signs for Base, an Ed25519 key for Solana. The private key never leaves KMS. `keyRef` is the key id, key ARN or alias ARN.

The Signer has no variables of its own for this backend. The AWS SDK finds the region and credentials through its standard provider chain: `AWS_REGION`, then `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, a profile (`AWS_PROFILE`), or the instance or task role it runs under. Prefer a role to long-lived access keys.

Each key is an asymmetric signing key (`SIGN_VERIFY`) with the key spec its curve needs:

| Curve | Chain | Key spec |
| --- | --- | --- |
| `secp256k1` | Base | `ECC_SECG_P256K1` |
| `ed25519` | Solana | `ECC_NIST_EDWARDS25519` |

The Signer refuses to start on a key whose spec doesn't match its address's curve, or whose usage isn't `SIGN_VERIFY`, and names the key, its spec and the spec it needs. Its credentials need only `kms:GetPublicKey` and `kms:Sign`, on those keys alone. The key's address comes from its public key: an EVM address for secp256k1, a base58 Solana address for Ed25519. [`docs/signer.md`](../docs/signer.md#aws-kms) has the commands to create a key, its IAM policy, and how to find its address.

The Signer asks KMS to sign the transaction's keccak256 hash as given (`Sign` with `MessageType: DIGEST` and `ECDSA_SHA_256`), turns the DER signature into `r` and `s`, lowers a high `s`, and finds the recovery bit against the key's address. A signature that doesn't recover to that address is never returned.

On `ed25519` the Signer asks KMS to sign the Solana message itself with pure Ed25519 (`Sign` with `MessageType: RAW` and `ED25519_SHA_512`), the RFC 8032 signature Solana verifies. It never uses `ED25519_PH_SHA_512`, which is HashEdDSA (Ed25519ph) over a digest and produces signatures Solana rejects. AWS documents the signature only as FIPS 186-5's EdDSA signature, which is the 64-byte `R || S`; the Signer refuses any other length, then verifies the signature against the key's address over the message before returning it. KMS signs RAW messages of up to 4096 bytes; a whole Solana transaction, signatures included, is at most 1232.

KMS support for Ed25519 is from the AWS KMS Developer Guide's [key spec reference](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html): `ECC_NIST_EDWARDS25519` is for signing and verification only, and `ED25519_SHA_512` is the "NIST FIPS 186-5, Section 7.6, EdDSA signature", for which KMS requires `MessageType:RAW`. The 4096-byte limit is from the [`Sign` API reference](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html).
