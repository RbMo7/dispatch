import type { Chain } from '../domain/chain.js';

export type AssetDecimals = (chain: Chain, asset: string) => number | undefined;
