Status: blocked-by-core-scaffold

# Native SOL transfer

Build the unsigned instruction for a plain native-SOL disbursement via `SystemProgram.transfer` — a `Call` (ADR-0018) whose destination is a recipient address, no token/mint involved, no account resolution needed (a SOL transfer doesn't need an ATA — issue 01 doesn't apply here). Must pass the conformance suite's relevant validation checks (malformed recipient rejected with a structured error, not a thrown exception).

This is the first, simplest disbursement path — no signing, no broadcast yet, just producing a correct unsigned instruction.
