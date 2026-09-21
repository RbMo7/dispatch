Status: blocked-by-core-scaffold

# Signing wiring

Wire this Chain Handler to the shared Signer client (core scaffold issue 04) for the `ed25519` curve: fetch a fresh blockhash immediately before requesting a signature (not earlier — a blockhash fetched too early goes stale under batch volume, per the reference implementation's own documented incident), compile the transaction message, send it to the Signer, and attach the returned signature. This issue is only the signing step in isolation — no broadcast yet (issue 05).
