# Senders and the Signer

Two names come up on almost every page. The **Sender** is the wallet that pays. The **Signer** is the separate service that holds the Sender's key. Keeping them apart is the main safety property of the engine.

## The Sender

The Sender is the address a Managed Dispatch's transactions are signed and paid from. The engine owns its nonce, so nothing else may send from the Sender while the engine runs. A second process sending from the same address would race the engine for nonces on Base.

Each enabled chain has exactly one Sender, set by `BASE_SENDER_ADDRESS` and `SOLANA_SENDER_ADDRESS`. To pay from two wallets on one chain, run two engines. A pool of Senders per chain is planned, not built ([ADR-0016](../adr/0016-sender-pool-deferred.md)).

The recipient of a payment is never a Sender. A recipient needs only an address.

A Sender can take three shapes:

- **A plain key.** The usual case. One key signs and pays.
- **A Squads multisig vault** on Solana, or **a Safe** on Base. This is a [Multisig Sender](./multisig-and-treasury.md): the multisig holds the funds, and its Approvers vote on every payment run. The engine acts through a key of its own that can propose and execute but never approve.
- **A plain key funded by a multisig.** This is a [Treasury](./multisig-and-treasury.md#treasury-a-multisig-that-tops-up-a-hot-sender). The engine sees an ordinary Sender. People top it up from the multisig.

`GET /v1/senders` shows each Sender's address, mode, balances and what the Signer reports about its key ([reference](../api/senders.md)).

## The Signer

The Signer is its own process, in `signer/`, with its own port (8421) and its own deployment. The engine never imports a signing library and never holds key material ([ADR-0002](../adr/0002-signer-is-a-network-boundary-not-a-library.md)). Only the worker asks the Signer for signatures. The API process only reads what each key is pinned to, for `GET /v1/senders`.

For each transaction, the worker sends the Signer the whole unsigned transaction, with a bearer token both sides share (`SIGNER_AUTH_TOKEN`). The Signer:

1. checks the token,
2. decodes the transaction,
3. checks it against the key's policy, if the key has one,
4. signs it with the key's backend,
5. writes one audit line to stdout, and answers.

The worker then checks that the signature really comes from the Sender's key before it writes the transaction down and sends it.

Because the Signer sees the whole transaction, it can refuse one ([ADR-0046](../adr/0046-the-signer-sees-the-whole-transaction-and-can-refuse-it.md)). A policy can limit which chain IDs a key signs for, which contracts or programs a transaction may touch, and how much ETH, SOL or each token one transaction may move. A refusal reaches you as an item `failed` with `SIGNER_REFUSED`, and it is never retried. Limits are per transaction. There is no daily limit.

## Where keys live

Each address in the Signer's config names its own backend, and one Signer can mix them:

| Backend | Where the key is | Use |
| --- | --- | --- |
| `aws-kms` | AWS KMS. The key never leaves it. | Production, the strongest option |
| `privy` | A Privy server wallet. The key never leaves Privy. | Production |
| `local` | An encrypted file, decrypted into the Signer's memory at startup | Production when you have neither of the above |
| `keyfile` | A plain JSON file of raw keys | Development only |

[Set up the Signer](../signer.md) walks through each backend, the policy rules, and running it on a private network.

## Why the split matters

If the engine's host is compromised, the attacker can ask the Signer to sign, but only what the policy allows, and only with the bearer token. If the Signer's host is compromised with `aws-kms` or `privy`, the key itself still does not leak. If the engine's database is lost, no key is lost with it. Put the Signer where only the worker can reach it, and give every production key a policy.
