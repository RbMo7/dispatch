import { NATIVE_ASSETS, refuseRepeatedAsset, type ConfigAsset } from '../../domain/known-asset.js';

export const NATIVE_ASSET_SYMBOL = NATIVE_ASSETS.solana.symbol;

/**
 * Parses `SOLANA_KNOWN_TOKENS`, a comma-separated list of
 * `SYMBOL:mint:decimals`, with `:token-2022` appended for a Token-2022 mint,
 * into the config rows the Known Asset registry is seeded with (ADR-0061).
 * Throws on a malformed entry: a misconfigured variable is a startup-time
 * configuration bug, not a business-relevant outcome (ADR-0010).
 */
export function parseSolanaKnownTokens(raw: string): ConfigAsset<'solana'>[] {
  const assets: ConfigAsset<'solana'>[] = [];
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    const [symbol, mint, decimalsRaw, program, ...extra] = entry.split(':');
    const decimals = Number(decimalsRaw);
    if (
      !symbol ||
      !mint ||
      !decimalsRaw ||
      !Number.isInteger(decimals) ||
      (program !== undefined && program !== 'token-2022') ||
      extra.length > 0
    ) {
      throw new Error(
        `SOLANA_KNOWN_TOKENS entry "${entry}" is malformed — expected SYMBOL:mint:decimals, or SYMBOL:mint:decimals:token-2022.`,
      );
    }
    if (symbol === NATIVE_ASSET_SYMBOL) {
      throw new Error(
        `SOLANA_KNOWN_TOKENS cannot redefine the reserved "${NATIVE_ASSET_SYMBOL}" symbol.`,
      );
    }
    refuseRepeatedAsset('SOLANA_KNOWN_TOKENS', assets, symbol, mint);
    assets.push({
      chain: 'solana',
      kind: program === 'token-2022' ? 'token-2022' : 'spl',
      address: mint,
      symbol,
      name: symbol,
      decimals,
    });
  }
  return assets;
}
