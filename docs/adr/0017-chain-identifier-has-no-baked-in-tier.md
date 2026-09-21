# Chain is a family, not a family-and-tier identifier — network is deployment config

The old `dispatch` repo's ADR-0010 folded network tier (Sandbox/Live) directly into its `Chain` identifier (`solana-devnet` vs. `solana-mainnet` as distinct values), because its multi-tenancy model needed a wallet per `(Tenant, Chain)` and a rule against mixing tiers in one Dispatch. This project carried that shape over into early planning without re-deciding it — on inspection, none of the reasons for it apply here: there's no tenant, no per-network wallet-provisioning rule to enforce, no tier-mixing validation needed. So `Chain` here means only the chain family (`evm`, `solana`); which network a Chain Handler instance talks to is an ordinary deployment config value (RPC URL, chain ID, mint/contract addresses) passed into it, not a separate type-level identity.

## Consequences

Running against both a testnet and a mainnet at once (e.g. a staging and a production deployment) just means running two separately-configured instances of the engine, not one engine that understands "tiers." If a real cross-tier concern shows up later (e.g. one deployment intentionally serving both networks and needing to keep them from mixing), revisit this then rather than pre-building for it.
