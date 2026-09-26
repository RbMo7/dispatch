Status: ready-for-agent

# 03: Native ETH transfer, end to end

**What to build:** The first full vertical slice: an integrator sends a Managed Dispatch `payment` item for native ETH on `"chain": "base"`, and it gets built, signed, and broadcast to a real transaction on Base Sepolia. This proves `paymentToCall`, `validateCall`, `prepare`, and `sign` together for the simplest case, and wires `broadcast`'s happy path (no retry/fee-bump logic yet — that's ticket 09). Every successful broadcast records the (nonce, hash) pair into ticket 02's persisted history.

**Blocked by:** 02 (nonce authority).

**Status:** ready-for-agent

- [ ] `paymentToCall` translates a native-asset `Payment` into `{to: recipient, data: "0x", value: amount}`
- [ ] `validateCall` rejects a malformed `EvmCall` (bad address shape) cheaply, with no RPC round-trip
- [ ] `prepare` builds an unsigned EIP-1559 (type `0x02`) transaction: chain ID baked in, nonce from ticket 02's counter, fee fields set per the fixed-multiplier heuristic (reads latest `baseFeePerGas` once, applies the documented multiplier for `maxFeePerGas`, uses the configured/fixed tip for `maxPriorityFeePerGas`)
- [ ] `sign` delegates to the Signer client (ADR-0002) and returns a signed transaction in the same opaque `SignedTransaction` shape every other chain uses
- [ ] `broadcast` calls `eth_sendRawTransaction` and returns the transaction hash; a rejected/unreachable RPC call is a structured `DispatchError`, never a thrown exception
- [ ] A successful broadcast appends `(nonce, hash)` to the persisted history from ticket 02
- [ ] Proven against real Base Sepolia: a native ETH payment submitted through this pipeline lands on-chain, independently verified against the recipient's real balance change
