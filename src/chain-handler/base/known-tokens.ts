import { getAddress, isAddress } from 'viem';

import { NATIVE_ASSETS, refuseRepeatedAsset, type ConfigAsset } from '../../domain/known-asset.js';

export const NATIVE_ASSET_SYMBOL = NATIVE_ASSETS.base.symbol;

/**
 * Parses `BASE_KNOWN_TOKENS`, a comma-separated list of
 * `SYMBOL:contractAddress:decimals`, into the config rows the Known Asset
 * registry is seeded with (ADR-0061). Throws on a malformed entry: a
 * misconfigured variable is a startup-time configuration bug (ADR-0010).
 */
export function parseBaseKnownTokens(raw: string): ConfigAsset<'base'>[] {
  const assets: ConfigAsset<'base'>[] = [];
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    const [symbol, contractAddress, decimalsRaw] = entry.split(':');
    const decimals = Number(decimalsRaw);
    if (
      !symbol ||
      !contractAddress ||
      !decimalsRaw ||
      !Number.isInteger(decimals) ||
      !isAddress(contractAddress, { strict: false })
    ) {
      throw new Error(
        `BASE_KNOWN_TOKENS entry "${entry}" is malformed — expected SYMBOL:contractAddress:decimals.`,
      );
    }
    if (symbol === NATIVE_ASSET_SYMBOL) {
      throw new Error(
        `BASE_KNOWN_TOKENS cannot redefine the reserved "${NATIVE_ASSET_SYMBOL}" symbol.`,
      );
    }
    refuseRepeatedAsset('BASE_KNOWN_TOKENS', assets, symbol, contractAddress);
    assets.push({
      chain: 'base',
      kind: 'erc20',
      address: getAddress(contractAddress),
      symbol,
      name: symbol,
      decimals,
    });
  }
  return assets;
}
