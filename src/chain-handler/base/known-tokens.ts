/**
 * The symbol -> {contractAddress, decimals} registry `paymentToCall`
 * (ADR-0028, issue 04) resolves a Payment's `asset` against for an ERC-20
 * transfer — the Base analogue of Solana's known-tokens.ts. Not
 * RPC-fetched: decimals must be known up front to build a correct
 * `transfer` encoding, so it's operator config, like `ENABLED_CHAINS`
 * (ADR-0019), not chain state.
 *
 * `ETH` is reserved for the native transfer path (issue 03) and is never a
 * key here. No contract is hardcoded by default — an operator configures
 * exactly the tokens they actually disburse.
 */
export type KnownToken = { contractAddress: string; decimals: number };
export type BaseTokenRegistry = Readonly<Record<string, KnownToken>>;

export const NATIVE_ASSET_SYMBOL = 'ETH';

export function resolveKnownToken(registry: BaseTokenRegistry, asset: string): KnownToken | undefined {
  return registry[asset];
}

/**
 * Parses the `BASE_KNOWN_TOKENS` config value — a comma-separated list of
 * `SYMBOL:contractAddress:decimals` triples, e.g. `USDC:0x036C...:6` — the
 * same config-driven-activation shape `SOLANA_KNOWN_TOKENS` already uses.
 * Throws on a malformed entry: a misconfigured operator env var is a
 * startup-time configuration bug, not a business-relevant outcome
 * (ADR-0010).
 */
export function parseBaseKnownTokens(raw: string): BaseTokenRegistry {
  const registry: Record<string, KnownToken> = {};
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    const [symbol, contractAddress, decimalsRaw] = entry.split(':');
    const decimals = Number(decimalsRaw);
    if (!symbol || !contractAddress || !decimalsRaw || !Number.isInteger(decimals)) {
      throw new Error(
        `BASE_KNOWN_TOKENS entry "${entry}" is malformed — expected SYMBOL:contractAddress:decimals.`,
      );
    }
    if (symbol === NATIVE_ASSET_SYMBOL) {
      throw new Error(
        `BASE_KNOWN_TOKENS cannot redefine the reserved "${NATIVE_ASSET_SYMBOL}" symbol.`,
      );
    }
    registry[symbol] = { contractAddress, decimals };
  }
  return registry;
}
