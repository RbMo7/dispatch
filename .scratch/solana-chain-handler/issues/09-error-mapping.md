Status: blocked-by-02,03,05,06,07

# Error mapping

One dedicated pass to map every Solana/RPC-specific failure this Chain Handler can actually produce — a program error code, an `InvalidAccountData`/`TokenAccountNotFoundError`, an RPC timeout or rate-limit response, a simulation failure on `sendTransaction` with `skipPreflight: false` — into the structured error shape from ADR-0010 (`{ code, message, chainDetail }`), reusing the shared `code` taxonomy (issue 02 of core-engine-scaffold) where a failure is genuinely the same kind of thing across chains (e.g. `INSUFFICIENT_FUNDS`), and adding Solana-specific detail in `chainDetail` rather than inventing new top-level codes per raw error string.

This issue exists on its own, after 02/03/05/06/07 are built, specifically so error handling gets a real, deliberate pass across the whole Chain Handler instead of being whatever `catch` block each earlier issue happened to write inline.
