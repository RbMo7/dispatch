Status: needs-triage

# Wire ChainRegistry into the Coordinator and consume ENABLED_CHAINS for real

Two related loose ends from issue 07's code review (2026-09-22), neither a bug, both "not actually connected yet":

1. **`config.enabledChains` (`src/config.ts`) has no caller.** It reads the `ENABLED_CHAINS` env var, but nothing in the codebase passes it through `parseEnabledChains` or into `ChainRegistry.load`. Expected for now — there's no real Chain Handler loader to register yet, and neither `app.ts` nor `worker.ts` has any `/dispatch` handling to wire a registry into. Dead code until the first real Chain Handler (Solana) exists.

2. **`Coordinator.chainHandlers` was widened from `Map<Chain, ChainHandler>` to `ReadonlyMap<Chain, ChainHandler>`** (in the issue 07 commit) so `ChainRegistry.handlers` — itself a `ReadonlyMap` — could be passed straight into a `Coordinator` without copying. But nothing in the codebase actually constructs both and connects them; the change was made ahead of the wiring that would justify it, touching an already-reviewed issue 06 file for a need issue 07 didn't itself ask for.

When `worker.ts` gets real wiring (likely once `solana-chain-handler` produces its first real loader, or whenever the API/worker processes are actually assembled): build a `ChainRegistry` from `parseEnabledChains(config.enabledChains)` and the real loaders, and pass `registry.handlers` straight into `new Coordinator({ chainHandlers: registry.handlers, ... })` — confirming the `ReadonlyMap` type actually gets used as intended, not just left as an unexercised type change.
