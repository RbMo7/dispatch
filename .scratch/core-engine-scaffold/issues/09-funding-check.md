Status: blocked-by-05,06

# Funding Check

Implement the pre-flight check from ADR-0024/CONTEXT.md: in the Coordinator's claim step, before any Execution Plan is formed for a batch, aggregate the required amount per asset across it and compare against the Sender's real balance via the Chain Handler's `getBalance`. A shortfall fails the affected `Call`s immediately with `INSUFFICIENT_FUNDS`, `chainDetail` naming exactly which asset and how much more is needed (ADR-0010's structured shape) — never discovered one `Call` at a time by letting each fail independently.

Test as a pure unit (fake repository + fake Chain Handler, per ADR-0013's two-tier testing split) — this is aggregation/comparison logic, not chain interaction, and shouldn't need a real RPC call to verify.
