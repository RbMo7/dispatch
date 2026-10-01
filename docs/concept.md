# Concept

Sending a blockchain transaction reliably is harder than it looks: nonce sequencing, batching, RPC failures, stuck/underpriced transactions, and confirmation tracking are the same tedious, easy-to-get-wrong problem on every chain, solved slightly differently on every chain. This engine exists to be that solved problem once, for any application built on top of it.

## Scenarios this covers

1. **Bulk disbursement.** A developer needs to pay hundreds or thousands of recipients. They configure their own chain RPC and a Signer (see CONTEXT.md), call `/dispatch`, and the engine handles nonce sequencing, batching, retries, and per-payment status — see **Managed Dispatch**.
2. **High-throughput backend/contract settlement.** A backend or contract-triggered process needs to fire many transactions from one wallet without hand-rolling nonce coordination under concurrency — also **Managed Dispatch**.
3. **Bring-your-own-wallet applications.** A DEX, DAO, or any application whose own end users sign their own transactions can hand the engine an already-signed transaction purely for reliable delivery and confirmation tracking, without the engine ever touching a user's key — **Relay Dispatch**.
4. **Chain coverage that grows without disruption.** Each chain family is its own Chain Handler behind one interface; adding a chain is adding a handler, never a change to the engine core, the Signer contract, or an existing handler.

## Delivery approach

Chain by chain, not all at once: each Chain Handler is built, tested, and hardened against its own real failure modes (see `docs/adr/`) before the next chain starts.

- **Shipped:** Solana (proven against devnet, including a 500-payment volume run, and reviewed for mainnet readiness) and Base (proven against Base Sepolia, including a 100+ transaction volume run with a real fee-bump and an on-chain nonce audit). Both support Managed Dispatch and Relay Dispatch. The README has a feature table.
- **Before mainnet:** production key backends for the Signer. Its keyfile backend is development-only (ADR-0002, ADR-0046).
- **Next, not yet designed:** webhooks instead of polling (ADR-0023), Ethereum L1 as its own chain (ADR-0035), and a Sender Pool for fault isolation across several sending wallets (ADR-0016).

See `CONTEXT.md` for vocabulary and `docs/adr/` for the specific decisions and their reasoning.
