/**
 * The symbol -> {mint, decimals} registry `paymentToCall` (ADR-0028) resolves
 * a Payment's `asset` against for an SPL transfer. Deliberately not
 * RPC-fetched (ADR-0028: paymentToCall does no RPC) — decimals must be known
 * up front to build a correct `TransferChecked` instruction, so it's
 * operator config, like `ENABLED_CHAINS` (ADR-0019), not chain state.
 *
 * `SOL` is reserved for the native transfer path (issue 02) and is never a
 * key here. No mint is hardcoded by default — an operator configures
 * exactly the tokens they actually disburse, mirroring the "activated by
 * config, not by code" discipline this project already applies to chains.
 */
export type KnownToken = { mint: string; decimals: number };
export type SolanaTokenRegistry = Readonly<Record<string, KnownToken>>;

export const NATIVE_ASSET_SYMBOL = 'SOL';

export function resolveKnownToken(
  registry: SolanaTokenRegistry,
  asset: string,
): KnownToken | undefined {
  return registry[asset];
}
