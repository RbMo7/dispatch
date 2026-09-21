# Stay on TypeScript/Node instead of rewriting in Go

Go was considered because Stellar's own Disbursement Platform (a comparable disbursement engine) is written in Go, and go-ethereum's official, Ethereum-Foundation-backed EVM tooling is excellent. But Solana — a day-one chain for this project, not a later one — has no official Anza-published Go SDK; the best option (`solana-go`) is now hosted under the Solana Foundation org but its own README still calls itself "in active development... unaudited." TypeScript's `@solana/web3.js` is Solana's own first-party client, on par with go-ethereum for EVM. Shipping Solana on a community, unaudited SDK on day one would undercut the project's core promise ("handle every chain without much of an issue") for a benefit (Go's concurrency ergonomics, single-binary distribution) that a Postgres-backed atomic nonce counter already covers well enough.

## Considered Options

- **Go**: first-party EVM (go-ethereum) and Stellar (`stellar/go-stellar-sdk`) SDKs, but community/unaudited-only Solana SDK.
- **TypeScript/Node** (chosen): first-party SDKs across all three chains considered so far (`viem`/`ethers`, `@solana/web3.js`, Stellar's JS SDK), reuses working, tested chain-execution code already written in this ecosystem.

## Consequences

If a systems language is wanted later for deployment reasons (single static binary, etc.), that's solvable within TypeScript (e.g. `bun compile`) without touching chain SDKs. If Solana ever gets an official first-party Go SDK, this decision is worth revisiting.
