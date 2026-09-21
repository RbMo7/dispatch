Status: blocked-by-core-scaffold

# Batching at volume

Bundle multiple payments into one transaction using Solana's native multi-instruction support (the reference implementation chunks up to 5 payments per transaction, sized for the worst case of a create-ATA instruction per recipient on top of each transfer — re-derive and confirm that number rather than assuming it still holds). Test against real solana-devnet at meaningful volume (the reference implementation's own comments cite issues surfacing only around 500 payments) — this is the integration test that actually proves the Chain Handler holds up under the load a real bulk-disburse call would produce, not just a two- or three-payment smoke test.
