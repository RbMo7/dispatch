Status: blocked-by-01

# SPL token transfer

Build the unsigned instructions for a token disbursement (USDC first) via `createTransferCheckedInstruction`, using issue 01's account resolution to derive the sender's and recipient's ATAs and prepend the idempotent create-ATA instruction. Distinct from issue 02 because the failure modes are genuinely different: a malformed mint, a sender ATA that doesn't hold enough of the token, decimals mismatches (`createTransferCheckedInstruction`'s whole purpose is catching that class of bug) — each needs its own structured error (ADR-0010), not reuse of the native-transfer path's error set.
