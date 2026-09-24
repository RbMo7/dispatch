Status: ready-for-agent

# 14: Base Sepolia volume test

**What to build:** The actual proof this feature is done, mirroring `solana-chain-handler` issue 12's devnet volume test: a real run against Base Sepolia large enough to exercise sequential Managed Dispatch, at least one Bulk Call bundle, and at least one fee-bump under real (if synthetic) fee pressure — not just the individual unit/conformance tests passing in isolation.

**Blocked by:** 13 (conformance suite validation).

**Status:** ready-for-agent

- [ ] A batch of many payments (mixed native ETH, ERC-20, and at least one raw contract call) is dispatched sequentially against real Base Sepolia and every item reaches a correct terminal state
- [ ] At least one Bulk Call bundle within that run completes with a mixed success/failure outcome, independently verified on-chain
- [ ] At least one transaction in the run is deliberately underpriced to force a real fee-bump, and the bumped replacement confirms
- [ ] The whole run's nonce sequence is verified gapless and collision-free against real on-chain state, not just the engine's own bookkeeping
- [ ] No fake chain behavior anywhere in this run — everything is real Base Sepolia RPC, real signing, real broadcast
