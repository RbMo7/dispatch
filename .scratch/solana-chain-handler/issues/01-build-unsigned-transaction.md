Status: blocked-by-core-scaffold

# Build unsigned transaction: SOL and SPL transfers

Implement the "build" half of the Chain Handler interface for Solana: given one or more payments and a Sender, produce an unsigned transaction — native SOL transfer via `SystemProgram.transfer`, SPL token transfer via `createTransferCheckedInstruction` with an idempotent associated-token-account creation instruction ahead of it (matching the reference implementation's approach, since ATA-may-not-exist is a real recipient-side case). Must pass the conformance suite's validation-related tests (rejects a malformed recipient/address, rejects an unsupported asset with a structured error per ADR-0010, not a thrown exception).

No signing, no broadcast yet — this issue produces an unsigned transaction and stops there.
