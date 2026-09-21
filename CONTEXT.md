# Dispatch Engine

An open-source, self-hosted execution engine for blockchain transactions. It takes a transaction — whether it builds it itself or receives it already signed by someone else's wallet — and handles the mechanical, error-prone part of getting it onto a chain reliably: nonce sequencing, batching, delivery retries, and confirmation tracking, so the application built on top of it never has to.

## Language

**Managed Dispatch**:
A dispatch where the engine itself builds the unsigned transaction, owns nonce assignment, and asks a Signer to sign it. This is the shape for a batch disbursement, or a backend/contract that needs many transactions sent reliably from a wallet its operator controls.
_Avoid_: Dispatch (ambiguous with Relay Dispatch — always say which mode)

**Relay Dispatch**:
A dispatch where the caller supplies an already fully-signed transaction from any wallet. The engine never builds it and never assigns its nonce — it only broadcasts, retries delivery of the same signed bytes, and tracks confirmation. This is the shape for an application whose own end users bring their own wallets (e.g. a DEX). A Relay Dispatch transaction that gets stuck cannot be fee-bumped by the engine — only the original signer can produce a valid replacement.
_Avoid_: Passthrough Dispatch, Proxy Dispatch

**Signer**:
A separate process, reachable only over a small network contract, that holds a wallet's private key and turns unsigned transaction bytes into a signature on request. The engine itself never imports a signing SDK and never holds key material — it only calls out to whichever Signer its operator configured. One Signer may hold keys for more than one Sender.
_Avoid_: SigningProvider (an earlier, in-process/library-coupled shape — deliberately not this), Custodian, Wallet

**Sender**:
The wallet a Managed Dispatch's transaction is signed and paid from — the address whose Signer the engine calls, and whose nonce it owns. Never the recipient's wallet; a recipient only ever needs a public address, no Signer involved.
_Avoid_: Wallet (ambiguous — always say Sender or Recipient)

**Chain Handler**:
The chain-specific plugin (one per chain family — EVM, Solana, …) responsible for building an unsigned transaction, broadcasting a signed one, and checking a transaction's status. A Chain Handler never itself calls a Signer or holds key material — that boundary belongs to the engine core, not the plugin.
_Avoid_: Chain Executor, Adapter

**Chain**:
A fully-qualified chain-family-and-tier identifier (e.g. `base-sepolia`, `solana-devnet`) — one registered Chain Handler configuration per value. Tier (Sandbox vs. Live) is derived from the value's suffix, never stored separately.
_Avoid_: Network, Environment

**Transaction**:
One broadcastable, chain-native unit with its own hash/signature.

**Attempt**:
One broadcast/confirmation-check of a Transaction's exact signed bytes. Resubmitting identical bytes (e.g. after an RPC timeout) is a new Attempt of the same Transaction. Anything that changes the signed bytes (a fee-bump replacement, a refreshed Solana blockhash) is a new Transaction, not a new Attempt of the old one.

**Retry Policy**:
The setting, defaulting off and configurable per Managed Dispatch request (with a global operator default), controlling whether the engine may fee-bump a stuck transaction. Off means nothing about a Dispatch can cost more than what was originally authorized unless the caller explicitly opts in.
_Avoid_: Fee Bump (the mechanism the policy turns on, not the policy itself), Auto-retry

**ABANDONED**:
The terminal status for a transaction the engine has stopped actively tracking without a definitive on-chain outcome — e.g. an EVM transaction that never confirmed within its timeout while Retry Policy is off. Distinct from `FAILED`, which means the chain itself rejected or reverted the transaction: an `ABANDONED` transaction may still land later, so the engine keeps a low-frequency background check running for it, for a bounded window, and reports if it does.
_Avoid_: FAILED (reserved for a definitive on-chain outcome only), CANCELLED (implies an action stopped it — nothing did)

**Bulk Call**:
An EVM Managed Dispatch batching mode, opt-in per request, where multiple payments are encoded as one call against a caller-supplied aggregator contract instead of one transaction per payment. The engine only knows how to encode against a documented interface (e.g. Multicall3's shape) — it never deploys or owns the contract itself. The default batching mode is one transaction per payment, sent sequentially under the Sender's nonce.
_Avoid_: Multicall (that's the caller's contract pattern, not the engine's concept), Batch Transaction

**Durable Nonce Execution**:
An opt-in Solana submission mode using a durable nonce account instead of a recent blockhash, for a Sender that needs offline/async signing or hits blockhash-expiry problems at very high volume. The default Solana mode is blockhash-refresh-and-resubmit.
_Avoid_: Nonce Account (the on-chain object the mode depends on, not the mode itself)
