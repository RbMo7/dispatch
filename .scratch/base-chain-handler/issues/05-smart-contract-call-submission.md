Status: ready-for-agent

# 05: Smart contract call submission (raw EvmCall)

**What to build:** An integrator submits a `call` item they've already encoded themselves — `{to, data, value}` targeting an arbitrary contract, not derived from a `Payment` — and it goes through the same build/sign/broadcast pipeline ticket 03 proved, exactly as opaque data (ADR-0018/0027: the engine never interprets `data`, the caller owns the ABI). This is the vertical slice that proves the `Call` primitive's generality holds for Base, not just the two Payment-derived shapes tickets 03/04 exercise.

**Blocked by:** 03 (native ETH transfer, end to end).

**Status:** ready-for-agent

- [ ] A `call` item with arbitrary non-empty `data` passes `validateCall`'s cheap shape check (still no RPC round-trip, still no interpretation of what `data` means)
- [ ] The same `prepare`/`sign`/`broadcast` pipeline from ticket 03 handles this call with no special-casing for "this is a contract call, not a transfer"
- [ ] Proven against real Base Sepolia against an actual deployed test contract (e.g. a simple counter or event-emitting contract): the call is broadcast, confirms, and its on-chain effect — a state change or an emitted event — is independently checked, not just "the transaction confirmed"
- [ ] A call to a contract that reverts is broadcast and fails on-chain, mapped the same way ticket 10's error mapping will handle any other on-chain rejection — this ticket doesn't need its own bespoke revert-handling, just confirm it doesn't crash or silently misreport
