Status: ready-for-agent

# 04: ERC-20 token transfer

**What to build:** Extend `paymentToCall` to a known ERC-20 asset (e.g. USDC on Base), reusing ticket 03's build/sign/broadcast pipeline completely unchanged — proving the pipeline is genuinely payment-shape-agnostic, not native-ETH-specific.

**Blocked by:** 03 (native ETH transfer, end to end).

**Status:** ready-for-agent

- [ ] `paymentToCall` translates a known ERC-20 `Payment` into `{to: tokenContractAddress, data: 0xa9059cbb + left-padded recipient + big-endian uint256 amount, value: "0"}`
- [ ] An unrecognized asset name answers `UNKNOWN_ASSET` (ADR-0029), the same pattern `SolanaChainHandler` already uses
- [ ] `getBalance` reads a known ERC-20 token balance via a `balanceOf` `eth_call`, feeding the Funding Check (ADR-0024) the same way native `eth_getBalance` does
- [ ] Proven against real Base Sepolia: an ERC-20 payment submitted through the ticket-03 pipeline lands on-chain, independently verified against the recipient's real token balance change
