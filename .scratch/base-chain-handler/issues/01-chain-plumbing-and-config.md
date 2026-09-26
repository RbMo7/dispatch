Status: ready-for-agent

# 01: Chain plumbing, config & chain-ID verification

**What to build:** A `base` Chain identity that an operator can enable the same way `solana` is enabled today (ADR-0019) — config for RPC URL, chain ID, Sender address, known ERC-20 tokens, fee-bump percentage default, and Bulk Call default batch size, following the exact shape `config.solana` already uses. `BaseChainHandler` exists as a class registered in `ChainRegistry`'s loaders, and on construction verifies its configured chain ID against the connected RPC's own `eth_chainId` — refusing to start on a mismatch rather than silently signing for the wrong network. This is prefactoring: no transfer/build/broadcast logic yet, just the seam everything else plugs into.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `Chain` union gains `base` (replacing the placeholder `evm` value) in both the domain type and `ChainRegistry`'s known-chains list
- [ ] `docs/api.md`'s wire examples are already correct (`"base"`, done in the design pass) — this ticket doesn't need to touch them again, just keep them accurate if anything here contradicts them
- [ ] `viem` is added as a dependency
- [ ] `config.base` exists with `rpcUrl`, `chainId`, `senderAddress`, `knownTokens`, `feeBumpPercent`, `bulkCallMaxBatchSize` — same env-var-driven pattern as `config.solana`
- [ ] `BaseChainHandler` is only imported/constructed when `base` is actually in `ENABLED_CHAINS` (ADR-0019) — a disabled build never opens an RPC connection
- [ ] Constructing `BaseChainHandler` against real Base Sepolia RPC with a correctly configured chain ID succeeds
- [ ] Constructing it with a deliberately wrong configured chain ID against real Base Sepolia RPC fails loudly at construction, not silently later
