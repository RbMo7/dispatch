Status: blocked-by-04

# Broadcast

Submit a signed transaction via `sendTransaction` against the configured RPC. Happy path only: this issue proves a correctly signed transaction reaches the network and gets a signature back — it does not handle what happens if the network rejects it or the blockhash expires before confirmation (issue 06), and does not handle checking whether it later confirms (issue 07). Keeping this narrow is deliberate — the retry and status logic each need to be verified against their own specific failure scenarios, not folded into "does broadcast work."
