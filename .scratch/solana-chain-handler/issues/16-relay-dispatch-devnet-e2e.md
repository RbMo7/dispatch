Status: blocked-by-14,15,core-scaffold-13,relay-dispatch-01,relay-dispatch-02,relay-dispatch-03,relay-dispatch-04

# Relay Dispatch real-devnet end-to-end proof

The actual proof this mode works for Solana, not just that its pieces individually pass — mirrors `dispatch-api-e2e.test.ts`'s own shape but for Relay Dispatch: sign a real transaction with a throwaway keypair entirely *outside* the engine (simulating a real caller's own wallet), `POST /v1/dispatch` with `mode: "relay"` and that signed transaction through the real API, drive it to a terminal state, poll `GET /v1/dispatch/:id` for the distinct relay response shape, and independently verify the transfer actually landed on real devnet (recipient balance, or the transaction's own on-chain logs for a non-transfer call) — not just that the engine's own bookkeeping says so.

Also cover the rejection path end to end: a garbage/malformed signed-transaction string gets a `400` immediately and never appears as a queued row at all (proving issue 14's validation is actually wired into the route from issue 03, not just unit-tested in isolation).

This is the last issue in the chain — it depends on every other relay-dispatch and solana-chain-handler piece landing first, by design: it exists to catch anything that individually passed but doesn't actually cohere end to end.
