import type { Chain } from '../domain/chain.js';

/** The decimals of `asset` on `chain`, or undefined when no configured asset has that symbol. */
export type AssetDecimals = (chain: Chain, asset: string) => number | undefined;
