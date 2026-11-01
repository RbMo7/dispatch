import { parseBaseKnownTokens } from '../chain-handler/base/known-tokens.js';
import { parseSolanaKnownTokens } from '../chain-handler/solana/known-tokens.js';
import type { Chain } from '../domain/chain.js';
import {
  applyConfigSeed,
  NATIVE_ASSETS,
  planConfigSeed,
  type ConfigAsset,
} from '../domain/known-asset.js';
import { AssetRegistry } from './asset-registry.js';

/** Each chain's `*_KNOWN_TOKENS` value. */
export type KnownTokensSetting = Record<Chain, string>;

/** ADR-0061: what the configuration says is known: each chain's native coin, then its `*_KNOWN_TOKENS`. Throws on a malformed variable. */
export function configuredAssets(knownTokens: KnownTokensSetting): ConfigAsset[] {
  return [
    NATIVE_ASSETS.solana,
    ...parseSolanaKnownTokens(knownTokens.solana),
    NATIVE_ASSETS.base,
    ...parseBaseKnownTokens(knownTokens.base),
  ];
}

/** The registry a fresh database holds once seeded from `knownTokens`: for tools and tests that run without one. */
export function registryFromConfig(knownTokens: Partial<KnownTokensSetting> = {}): AssetRegistry {
  const configured = configuredAssets({ solana: '', base: '', ...knownTokens });
  const plan = planConfigSeed([], configured);
  if (!plan.ok) throw new Error(plan.error);
  let next = 0;
  return AssetRegistry.of(
    applyConfigSeed([], plan.value, () => ({ id: `config-${next++}`, addedAt: new Date(0) })),
  );
}
