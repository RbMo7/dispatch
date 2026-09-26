# The Base Sepolia volume run is opt-in

ADR-0013 has every Chain Handler test run against the real network. Solana's devnet volume test (500 payments) runs on every suite run, because devnet SOL is free to top up. Base Sepolia ETH isn't: the dev-sender is funded by hand and holds hundredths of an ETH. #15's volume run sends more than a hundred transactions and deploys nothing, but it still costs about 0.00002 ETH and several minutes on every run. Paid for on every `pnpm test`, it would drain the wallet that every other Base e2e test depends on.

So `base-sepolia-volume.test.ts` runs only when `RUN_BASE_VOLUME=1` is set. It still uses real Base Sepolia, real signing and real broadcast, with no fake chain behavior (ADR-0013); only *when* it runs changes. The smaller Base e2e files (fee-bump, Bulk Call, Relay, nonce gaps) keep running on every suite run, as ADR-0013 intends.

## Consequences

- **Not re-proven automatically.** A normal suite run doesn't re-prove #15. Run it on purpose before a release, or after changing the Coordinator, the nonce authority, or the Base handler's send path.
- **Revisit the gate** if the dev-sender ever gets automated top-ups (a faucet API), or if the run gets cheap enough to include by default.
