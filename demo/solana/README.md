# Relay Dispatch against a custom program

A worked example proving dispatchxyz's Relay Dispatch handles a genuinely
custom, freshly-deployed Solana program — not just `SystemProgram`, SPL
Token, or the Memo program the engine's own tests already use.

## What's here

- **`internal-asset-program/`** — a minimal Anchor program. Balances live
  entirely in the program's own PDA-owned accounts, deliberately separate
  from SPL Token, so it's a genuinely novel "asset" the engine has never
  seen the shape of before. Two instructions:
  - `initialize_asset(initial_balance)` — creates an owner's balance PDA
  - `transfer_asset(amount)` — moves balance between two owners' PDAs,
    requiring the sender's signature
- **`demo-internal-asset-relay.ts`** — builds and signs a `transfer_asset`
  call entirely outside dispatchxyz (raw Anchor instruction-discriminator
  encoding, no `@coral-xyz/anchor` SDK on this side), then hands the signed
  bytes to a real, in-process dispatchxyz app via `POST /v1/dispatch` with
  `mode: "relay"`, drives it to confirmation through a real `Coordinator`
  and `SolanaChainHandler`, and independently verifies the transfer by
  reading the program's own on-chain state back.

## Prerequisites

- Rust + `cargo`, the Solana CLI (`cargo-build-sbf`), and the Anchor CLI
  (`avm`/`anchor`)
- A funded devnet wallet. Reuses dispatchxyz's own cached one
  (`.devnet-fixtures/sender-keypair.json` at the repo root — created the
  first time any of the engine's real-devnet tests run; see the main repo's
  own test setup if it doesn't exist yet)
- Optionally, `SOLANA_DEVNET_RPC_URL` set to your own devnet RPC — the
  public `api.devnet.solana.com` endpoint (the default) is heavily
  rate-limited under any real usage

## Running it

```bash
cd demo/solana/internal-asset-program
yarn install
anchor build
anchor deploy
npx tsx scripts/init-assets.ts   # creates + funds the two demo accounts

cd ../../..   # back to the repo root
node_modules/.bin/tsx demo/solana/demo-internal-asset-relay.ts
```

`init-assets.ts` generates a fresh recipient keypair on first run
(`internal-asset-program/scripts/owner-b-keypair.json`, gitignored) and
reuses it on subsequent runs.

### A toolchain gotcha worth knowing about

The Solana CLI's bundled `platform-tools` (used by `cargo-build-sbf` /
`anchor build`) ships its own pinned `cargo`, which can lag well behind
crates.io. At the time this demo was built, several transitive dependencies
(`zeroize`, `toml_edit`, `indexmap`, ...) had moved to Rust's `edition2024`,
which that bundled `cargo` couldn't even parse the manifest of —
`anchor build` failed with `feature 'edition2024' is required` on an
unrelated dependency several layers down.

Pinning each offending crate's version is a real fix but genuinely
whack-a-mole (fixing one surfaces the next). The actual fix is a newer
`platform-tools` release:

```bash
cargo-build-sbf --tools-version v1.57 --install-only --force-tools-install
anchor build -- --tools-version v1.57
```

(`anchor idl build` — run separately, with no extra args — regenerates
`target/idl/internal_asset.json` if `anchor build`'s own IDL step
complains about an unrecognized `--tools-version` flag leaking into it.)

`Cargo.lock` is committed here specifically so a fresh clone doesn't have
to rediscover this.
