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

**Call**:
The primitive a Chain Handler actually consumes for one line item of a Managed Dispatch: a destination plus opaque, caller-supplied data — `{to, data, value}` on EVM, `{programId, accounts, data}` on Solana — that the engine submits without needing to understand its semantics. Anything beyond a plain transfer, including a beneficiary's own application-defined contract call, is a Call the caller already encoded themselves (they own the ABI/IDL, not the engine).
_Avoid_: Transaction (that's the broadcast unit a Call becomes, not the request shape), Instruction (Solana-specific; a Call generalizes across chains)

**Payment**:
The convenience shape for a plain asset transfer — `recipient`/`asset`/`amount` — that the API layer translates into a Call (a native transfer or a known token-transfer encoding) before it ever reaches a Chain Handler. Every Payment is a Call; not every Call is a Payment.

**Idempotency Key**:
A client-supplied string, required on every Dispatch, that makes creating one a create-once operation — resubmitting the same key returns the original Dispatch rather than creating a new one. Scoped globally, not per-tenant (there is no tenant dimension here).

**Funding Check**:
A pre-flight check the Coordinator runs before forming an Execution Plan for a claimed batch: aggregates the required amount per asset across it and compares against the Sender's real balance (via the Chain Handler's `getBalance`). A shortfall fails the affected Calls immediately with a structured `INSUFFICIENT_FUNDS` error naming exactly which asset and how much more is needed — never discovered one `Call` at a time. Runs in the Coordinator's claim step, never on the `POST /v1/dispatch` ingest path. Each amount is checked against whoever actually pays it: the Sender, except for a Bulk Call's ERC-20 items, which spend the aggregator's own balance (ADR-0038). What sending costs beyond the payments (fees, and on Solana rent for new token accounts) is added to the Sender's native requirement (ADR-0043).
_Avoid_: Prefunded/Reactive Funding Mode (an old-repo distinction not carried over — this is the single, simpler check; an auto-resume-once-funded mode would be a later addition on top of it, not a redesign)

**Chain Handler**:
The chain-specific plugin (one per Chain — `base`, `solana`, …) responsible for building an unsigned transaction, broadcasting a signed one, and checking a transaction's status. A Chain Handler never itself calls a Signer or holds key material — that boundary belongs to the engine core, not the plugin.
_Avoid_: Chain Executor, Adapter

**Chain**:
One Chain Handler implementation per Chain. A Chain is the unit that actually needs its own fee-computation, signing-envelope, and confirmation logic — not every distinguishable network gets one. Within a Chain, which network an operator talks to (devnet vs. mainnet-beta, Base mainnet vs. Base Sepolia) is a deployment config detail (RPC URL, chain ID, mint/contract addresses) passed into that one Chain Handler, never a separate type-level identity — there is no multi-tenancy or per-network wallet-provisioning rule here that would require one (ADR-0017). But two networks that only *share a virtual machine and wire format* while differing in fee model and confirmation semantics are not one Chain: `base` (an OP-Stack L2, with its own L1 data fee and sequencer-driven confirmation model) and Ethereum L1 are separate Chains, not `evm`-family config variants of each other (ADR-0035) — `solana` remains the only other Chain so far.
_Avoid_: Network, Environment, Tier, Sandbox/Live (config values within a Chain, not concepts the engine's own code branches on), `evm` (not a Chain here — there is no single EVM-family Chain Handler; `base` and any future Ethereum-L1 handler are each their own Chain)

**Sender Pool** (roadmap — not yet built):
Several Sender wallets under one logical operator, each with its own independent nonce sequence, that a large Managed Dispatch batch spreads across — inspired by Stellar SDP's channel accounts. The purpose is fault isolation, not raw throughput: a transaction stuck in one Sender's sequence only blocks that Sender's own remaining queue, not the whole batch. Requires pre-funding/allocation across the pool and each member registered with a Signer — deferred out of the first phase; single-Sender sequential dispatch (already safe via the atomic nonce counter and the `ABANDONED`/Retry Policy handling) ships first.

**Transaction**:
One broadcastable, chain-native unit with its own hash/signature. Always written down, hash included, *before* it is sent (ADR-0041), so a crash or an ambiguous send can never lose track of one that may land. Its status is `PENDING`, `CONFIRMED`, `FAILED` or `ABANDONED`. A fee-bumped Call also has `REPLACED` versions (superseded, still watched) and `DROPPED` ones (another version settled the Call, or, for a Solana Call resubmitted after its blockhash expired, the version provably can never land, ADR-0042). Those two are never a Call's reported status.

**Attempt**:
One broadcast/confirmation-check of a Transaction's exact signed bytes. Resubmitting identical bytes (e.g. after an RPC timeout, or a Stuck Transaction's rebroadcast) is a new Attempt of the same Transaction, recorded even when the node answers "already known". Anything that changes the signed bytes (a fee-bump replacement, a refreshed Solana blockhash) is a new Transaction, not a new Attempt of the old one.

**Retry Policy**:
The setting, defaulting off and configurable per Managed Dispatch request (with a global operator default), controlling whether the engine may fee-bump a Stuck Transaction: build a new Transaction at the same nonce with both fees raised, up to a capped number of attempts (ADR-0037). Off means nothing about a Dispatch can cost more than what was originally authorized unless the caller explicitly opts in; a stuck transaction is then only rebroadcast, never repriced. Meaningless for Relay Dispatch, where the engine holds no key.
_Avoid_: Fee Bump (the mechanism the policy turns on, not the policy itself), Auto-retry

**ABANDONED**:
The terminal status for a transaction the engine has stopped actively tracking without a definitive on-chain outcome — e.g. an EVM transaction that never confirmed within its timeout while Retry Policy is off. Distinct from `FAILED`, which means the chain itself rejected or reverted the transaction: an `ABANDONED` transaction may still land later, so the engine keeps a low-frequency background check running for it, for a bounded window, and reports if it does. With Retry Policy on, abandonment waits only while the transaction can still be fee-bumped.
_Avoid_: FAILED (reserved for a definitive on-chain outcome only), CANCELLED (implies an action stopped it — nothing did)

**Bulk Call**:
An EVM Managed Dispatch batching mode, opt-in per request, where multiple payments are encoded as one call against a caller-supplied aggregator contract instead of one transaction per payment. The engine only knows how to encode against a documented interface (Multicall3's `aggregate3Value`) — it never deploys or owns the contract itself (ADR-0038). By default a bundle lands whole or fails whole (`allowFailure: false`); per-item success and failure is opt-in and needs a tracing RPC. ERC-20 items spend the aggregator's own balance, so they're refused through the canonical, permissionless Multicall3. The default batching mode, without Bulk Call, is one transaction per payment, sent sequentially under the Sender's nonce.
_Avoid_: Multicall (that's the caller's contract pattern, not the engine's concept), Batch Transaction

**Stuck Transaction**:
A `PENDING` EVM transaction still unconfirmed a configured time (`stuckAfterMs`, 60s on Base) after its latest send (ADR-0037). Stuck handling rebroadcasts its identical bytes, or fee-bumps it when Retry Policy allows. Only chains that opt in get stuck handling; Solana's expiring blockhash resolves stuck transactions on its own.
_Avoid_: Dropped (a mempool eviction is one possible cause, not the state), Failed

**Durable Nonce Execution**:
An opt-in Solana submission mode using a durable nonce account instead of a recent blockhash, for a Sender that needs offline/async signing or hits blockhash-expiry problems at very high volume. The default Solana mode is blockhash-refresh-and-resubmit.
_Avoid_: Nonce Account (the on-chain object the mode depends on, not the mode itself)
