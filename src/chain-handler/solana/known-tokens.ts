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

/**
 * Parses the `SOLANA_KNOWN_TOKENS` config value — a comma-separated list of
 * `SYMBOL:mint:decimals` triples, e.g. `USDC:EPjF...:6` — the same
 * config-driven-activation shape as `ENABLED_CHAINS` (ADR-0019). Throws on
 * a malformed entry: a misconfigured operator env var is a startup-time
 * configuration bug, not a business-relevant outcome (ADR-0010).
 */
export function parseSolanaKnownTokens(raw: string): SolanaTokenRegistry {
  const registry: Record<string, KnownToken> = {};
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    const [symbol, mint, decimalsRaw] = entry.split(':');
    const decimals = Number(decimalsRaw);
    if (!symbol || !mint || !decimalsRaw || !Number.isInteger(decimals)) {
      throw new Error(
        `SOLANA_KNOWN_TOKENS entry "${entry}" is malformed — expected SYMBOL:mint:decimals.`,
      );
    }
    if (symbol === NATIVE_ASSET_SYMBOL) {
      throw new Error(`SOLANA_KNOWN_TOKENS cannot redefine the reserved "${NATIVE_ASSET_SYMBOL}" symbol.`);
    }
    registry[symbol] = { mint, decimals };
  }
  return registry;
}
