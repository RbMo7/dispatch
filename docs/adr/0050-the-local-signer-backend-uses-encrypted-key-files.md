# The local Signer backend uses encrypted key files, managed by a CLI

ADR-0046's `keyfile` backend is dev only: plaintext keys in a committed JSON file. An operator with no AWS or Privy account has no safe production option, so the Signer needs a local backend. Its file format is hard to change once operators hold keys in it.

## Decision

- **A new backend, `local`, next to `keyfile`.** `keyfile` stays dev only and keeps its loud warning.
- **One encrypted file per key.** scrypt derives the encryption key from a passphrase, and AES-256-GCM encrypts the key (Node's built-in `crypto`, no new dependency). The file records the curve and the derived address. It holds both curves, secp256k1 and ed25519.
- **The passphrase is supplied at startup**, from an environment variable or a mounted secret file, never a command-line argument. The Signer decrypts every referenced key into memory and refuses to start on a wrong passphrase or an address mismatch (ADR-0046's startup check).
- **A CLI manages keys:** `new`, `import` (key read from stdin), `list` and `export-public`. It never prints or exports a private key.
- **No UI for key management in this feature.** A web UI that creates or imports keys would add a large attack surface to the one component meant to stay small.

## Considered options

- **Web3 Secret Storage (keystore v3).** Rejected: it is EVM-only, and Solana needs ed25519.
- **A key in an environment variable.** Rejected: it shows up in process listings and crash dumps, and gives no encryption at rest.
- **Hardware wallets on the operator's machine.** Rejected for now: they need a person to confirm each signature, which does not fit unattended dispatch.

## Consequences

- `local` is the weakest production option: the decrypted key sits in the Signer's process memory, so a host compromise exposes it. KMS and Privy keep the key outside the host. The runbook ranks the three and says so.
- Losing the passphrase loses the keys, and the CLI cannot recover them. The runbook says to back both up.
- Rotating the passphrase means re-encrypting each file, which the CLI does not do in this feature.
- Per-address policy (ADR-0046) applies to `local` addresses as to any other, and is the main protection for this backend.
