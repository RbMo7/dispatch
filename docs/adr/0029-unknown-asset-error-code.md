# `UNKNOWN_ASSET` is a chain-agnostic error code, added while building `paymentToCall`

Building `solana-chain-handler`'s `paymentToCall` (issues 02/03, ADR-0028) surfaced a failure mode core-engine-scaffold's issue 02 error taxonomy didn't cover: a `Payment.asset` naming a symbol this Chain Handler has no known encoding for (not `SOL`, not one of the mints/symbols it's configured with). None of the existing six codes fit — `INVALID_RECIPIENT` is specifically about the recipient address, not the asset; the rest don't apply at all.

This is the same shape of problem on every chain a `paymentToCall` gets built for (an EVM handler hits the identical case for an unrecognized ERC-20 symbol), so it belongs in the shared taxonomy (`src/domain/errors.ts`) rather than being invented as a Solana-specific code — consistent with `solana-chain-handler` issue 09's own instruction to reuse the shared `code` set for a genuinely shared kind of failure and reserve `chainDetail` for the chain-specific part.

## Consequences

`DispatchErrorCode` gains `UNKNOWN_ASSET`. `SolanaChainHandler.paymentToCall` returns it when `Payment.asset` isn't `SOL` and isn't a configured/known token; `chainDetail` carries the asset string it couldn't resolve.
