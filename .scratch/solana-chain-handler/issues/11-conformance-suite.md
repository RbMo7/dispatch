Status: blocked-by-01,02,03,04,05,06,07,08,09,10

# Conformance suite validation

Run this Chain Handler against the shared conformance suite from `core-engine-scaffold` issue 05 and fix whatever it finds. This is the checkpoint that proves the extendibility rule (ADR-0015) actually held — that nothing about building Solana required a change to the Coordinator, the Signer contract, or the suite itself. If it did, that's a signal the interface was wrong, not something to patch around here.
