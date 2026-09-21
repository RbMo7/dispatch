Status: blocked-by-02,03

# Bundling multiple payments into one transaction

Chunk multiple Calls into one transaction using Solana's native multi-instruction support (the reference implementation used up to 5 payments per transaction, sized for the worst case of a create-ATA instruction per recipient on top of each transfer — re-derive and confirm that number against current transaction-size and compute-budget limits rather than assuming it still holds). This is Solana's answer to batching (ADR-0006 — no separate Bulk Call concept needed here, unlike EVM) and is its own issue precisely because "does bundling work" is a different question from "does a single transfer work" (issues 02/03) — a bundling bug (e.g. exceeding transaction size, wrong account list ordering) would otherwise be invisible until volume, not caught by single-payment tests.
