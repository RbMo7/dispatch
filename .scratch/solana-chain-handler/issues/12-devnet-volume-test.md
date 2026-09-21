Status: blocked-by-11

# Devnet volume test

The final proof, at real scale against real solana-devnet (ADR-0013) — not a two- or three-payment smoke test. The reference implementation's own comments cite issues surfacing only around 500 payments; this issue must actually reach comparable volume and exercise bundling (10), retry (06), and error mapping (09) together under load, not each in isolation. This is what earns the claim that the Solana Chain Handler is done, not just that its pieces individually pass.
