Status: ready-for-agent

# 10: Error mapping

**What to build:** A dedicated pass (mirroring `solana-chain-handler` issue 09) mapping the failure modes tickets 03/06/09 actually produce — RPC unreachability, a rejected/reverted broadcast, a replacement-transaction rejection — to this repo's structured `DispatchError` codes (ADR-0010), instead of inline ad-hoc handling scattered across those tickets.

**Blocked by:** 03 (native ETH transfer), 06 (status and confirmation tracking), 09 (fee-bump retry).

**Status:** ready-for-agent

- [ ] An unreachable/timing-out RPC call maps to `RPC_UNAVAILABLE`
- [ ] A broadcast the chain itself rejects (not a network failure — an actual node-level rejection) maps to `CHAIN_REJECTED`
- [ ] A Signer that can't be reached maps to `SIGNER_UNREACHABLE`, unchanged from the existing cross-chain code
- [ ] A malformed recipient/address shape maps to `INVALID_RECIPIENT`
- [ ] Every mapped error includes enough `chainDetail` (ADR-0010) for an integrator to understand what actually went wrong, not just a generic message
- [ ] No error produced anywhere in tickets 03/06/09's paths surfaces as a thrown exception instead of a structured `Result` error
