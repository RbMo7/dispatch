Status: blocked-by-05

# Chain registry and selective loading

Build the registry (ADR-0019): reads `ENABLED_CHAINS` (a config list, e.g. `solana,stellar`), and for each named chain dynamically imports and registers its Chain Handler — anything not listed is never imported, never opens an RPC connection, never starts a polling loop. A `/dispatch` (or worker-side) request naming a chain that isn't enabled returns the structured `CHAIN_NOT_ENABLED` error (ADR-0010/issue 02), not a crash.

Depends on issue 05 (the Chain Handler interface must exist to register anything against it), but does not depend on a real Chain Handler existing yet — this can and should be tested with the same trivial stub used in issues 05/06, registered conditionally, to prove the on/off behavior works before Solana is real.
