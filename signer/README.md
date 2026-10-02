# The Signer

The Signer holds each Sender's key and answers the engine's `POST /sign` (ADR-0002, ADR-0046). It is its own package: the engine never imports it, and vendor SDKs live only here.

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

## Backends

### `keyfile`

For development only. It reads raw private keys from a JSON file, `{ "secp256k1": { "<keyRef>": "<hex>" }, "ed25519": { "<keyRef>": "<hex seed>" } }`, and warns at startup.

- `SIGNER_KEYFILE`: the file's path.

`keys.dev.json` and `signer.config.dev.json` are the committed dev keys and their config, which Compose and `pnpm dev` use.

### `privy`

Keys held by Privy server wallets. The private key never leaves Privy; the Signer holds only API credentials. `keyRef` is the Privy wallet id. An Ethereum wallet signs for `secp256k1`, a Solana wallet for `ed25519`.

- `PRIVY_APP_ID`, `PRIVY_APP_SECRET`: the app's API credentials.
- `PRIVY_AUTHORIZATION_KEY` (optional, recommended): the private key of a Privy authorization key, as Privy shows it (`wallet-auth:...`). When set, every signing request is signed with it.

Make each wallet owned by the authorization key and set `PRIVY_AUTHORIZATION_KEY`. Privy then refuses to sign for the wallet unless the request carries that key's signature, so leaked app credentials alone can't sign. Without an owner, the app secret alone is enough. The mainnet checklist (#52) will require one.

On `secp256k1` the Signer asks Privy to sign the transaction's keccak256 hash (the `secp256k1_sign` RPC; Privy refuses `raw_sign` for Ethereum wallets), lowers a high `s` and finds the recovery bit against the wallet's address. On `ed25519` it sends the Solana message to Privy as an unsigned transaction (`signTransaction`), so Privy's own transaction policies still apply. Either way, a signature that doesn't verify for the wallet's address is never returned.

### `aws-kms`

Keys held in AWS KMS, for `secp256k1` only; Solana keys go on Privy until #51 settles whether KMS can hold them. The private key never leaves KMS. `keyRef` is the key id, key ARN or alias ARN.

The Signer has no variables of its own for this backend. The AWS SDK finds the region and credentials through its standard provider chain: `AWS_REGION`, then `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, a profile (`AWS_PROFILE`), or the instance or task role it runs under. Prefer a role to long-lived access keys.

Create the key as an asymmetric signing key on secp256k1:

```sh
aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY --description "dispatch Base sender"
```

The Signer refuses to start on a key with any other key spec or usage. Its credentials need only these two actions, on that key alone:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["kms:GetPublicKey", "kms:Sign"],
      "Resource": "arn:aws:kms:<region>:<account>:key/<key id>"
    }
  ]
}
```

The key's EVM address comes from its public key. To find it, configure the key under a placeholder address and start the Signer. It refuses to start and prints the address the key derives:

```
signer refused to start: these addresses don't match their keys:
  0x0000000000000000000000000000000000000000: expected 0x0000000000000000000000000000000000000000, derived 0x...
```

Then configure the key under that derived address:

```json
{
  "<the key's derived address>": {
    "curve": "secp256k1",
    "backend": "aws-kms",
    "keyRef": "arn:aws:kms:<region>:<account>:key/<key id>"
  }
}
```

The Signer asks KMS to sign the transaction's keccak256 hash as given (`Sign` with `MessageType: DIGEST` and `ECDSA_SHA_256`), turns the DER signature into `r` and `s`, lowers a high `s`, and finds the recovery bit against the key's address. A signature that doesn't recover to that address is never returned.
