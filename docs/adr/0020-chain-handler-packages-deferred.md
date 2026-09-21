---
status: accepted — amends ADR-0014's packaging call
---

# Chain Handler packages will split from the core — deferred until after the hackathon

ADR-0014 deferred splitting each Chain Handler into its own npm package for lack of a real, present need. That need is now real: an operator who only wants Solana shouldn't have to install the EVM and Stellar SDKs too. So the eventual shape is confirmed — each Chain Handler becomes its own installable package (`@dispatchxyz/chain-solana`, `@dispatchxyz/chain-evm`, …), so an unwanted chain's dependencies are never even downloaded. But the actual split is deferred until after the hackathon deadline: it requires new tooling (npm workspaces, per-package build config, cross-package type resolution) during the exact window that should be spent on the Solana Chain Handler itself.

## Consequences

ADR-0019's config-driven activation delivers the operator-visible behavior ("only configured chains run") in the meantime, inside the current single-package structure. The folder layout already in place (`chains/evm/`, `chains/solana/`, …) extracts into packages mechanically when the split happens, since the Chain Handler interface is already the seam — this is a later packaging move, not a later redesign.
