Status: blocked-by-core-scaffold

# Status tracking and ABANDONED timeout

Implement `getStatus` against Solana's commitment levels (`processed`/`confirmed`/`finalized`) and wire the chain-aware `ABANDONED` timeout for Solana specifically (ADR-0004): since blockhash expiry (~150 slots, ~60-90s) is a provable dead end, Solana's default abandonment point should be pinned to shortly after that expiry — a definitive `FAILED`-equivalent is available here in a way EVM never gets (ADR-0004's EVM asymmetry doesn't apply to Solana the same way; confirm and document whether Solana even needs the `ABANDONED` status at all, or whether its expiry gives it a clean `FAILED` instead).

This is the first place chain-specific finality reasoning gets exercised end-to-end against real devnet confirmations, not simulated ones.
