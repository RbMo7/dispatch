import type { Call, EvmCall, SolanaCall } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { TransactionEffects } from '../domain/effects.js';
import { decodeBaseCall, decodeBaseEffects } from './base.js';
import { decodeSolanaCall, decodeSolanaEffects } from './solana.js';
import type { AssetAt, CallView, EffectsView } from './view.js';

/** ADR-0063: an item's call, decoded; `effects`, once its transaction confirmed, can name what a Solana call moved. */
export function decodeCall(
  chain: Chain,
  call: Call,
  assetAt: AssetAt,
  effects?: TransactionEffects,
): CallView {
  return chain === 'base'
    ? decodeBaseCall(call as EvmCall, assetAt)
    : decodeSolanaCall(
        call as SolanaCall,
        assetAt,
        effects?.chain === 'solana' ? effects : undefined,
      );
}

/** ADR-0063: what a confirmed transaction changed, decoded from its stored effects. */
export function decodeEffects(effects: TransactionEffects, assetAt: AssetAt): EffectsView {
  return effects.chain === 'base'
    ? decodeBaseEffects(effects, assetAt)
    : decodeSolanaEffects(effects, assetAt);
}
