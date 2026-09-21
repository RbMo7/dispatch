# Signing lives behind a network boundary (a separate Signer process), not an in-process interface

The engine's stated identity is "just an execution engine" — it should not need to handle signing at all. An earlier design (a same-process `SigningProvider` interface calling a vendor SDK like Turnkey/Privy directly) still coupled the engine's dependency tree and runtime to specific signing vendors, even though it never held raw keys itself. Instead, the engine calls a minimal HTTP contract (`POST /sign {chain, curve, address, unsignedTxBytes} -> {signature}`) against a Signer the operator runs as a separate process. The core repo ships zero signing-vendor SDKs and holds no key material; reference Signers (a trivial local-keyfile one for dev/testnet, examples for KMS/HSM/custody vendors) live outside the core dependency tree.

## Considered Options

- **In-process plugin interface**: simplest to wire up, but couples the engine's most complex code (batching, retries, nonce logic — the most bug-prone surface) with whatever touches the private key.
- **Fully caller-signed transactions** (no engine-built unsigned tx at all): rejected — nonce assignment must be owned by one authority for the concurrency-safety story to hold, so the engine still has to build the unsigned transaction before anyone can sign it; making the caller round-trip through signing per-payment would defeat batch/fire-and-forget dispatch, reintroducing the exact problem this engine exists to remove. (This shape is still supported, but as Relay Dispatch for pre-signed transactions from *other* wallets the engine never built for — not as a substitute for Managed Dispatch's own signing step.)
- **Network-boundary Signer, per-transaction, synchronous** (chosen): keeps the core engine provably signing-agnostic, lets a self-hoster run the Signer on a more locked-down box/network segment, and lets signing infrastructure (local key file → KMS → HSM → custody vendor) be swapped without ever touching engine code.

## Consequences

Running the engine now means running two processes instead of one. Mitigated by shipping the reference local-keyfile Signer in the same `docker-compose.yml`, so first-time setup is still one command. Batch signing (one call to sign N transactions) is deferred until per-transaction round-trip latency is shown to matter — the v1 contract is per-transaction only.
