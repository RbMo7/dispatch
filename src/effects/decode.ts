import type { Call, EvmCall, SolanaCall } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { TransactionEffects } from '../domain/effects.js';
import { decodeBaseCall, decodeBaseEffects } from './base.js';
import { decodeSolanaCall, decodeSolanaEffects } from './solana.js';
import type { CallView, EffectsView, Known } from './view.js';

/** ADR-0063: an item's call, decoded; `effects`, once its transaction confirmed, can name what a Solana call moved. */
export function decodeCall(
  chain: Chain,
  call: Call,
  known: Known,
  effects?: TransactionEffects,
): CallView {
  return chain === 'base'
    ? decodeBaseCall(call as EvmCall, known)
    : decodeSolanaCall(
        call as SolanaCall,
        known,
        effects?.chain === 'solana' ? effects : undefined,
      );
}

/** ADR-0063: what a confirmed transaction changed, decoded from its stored effects. */
export function decodeEffects(effects: TransactionEffects, known: Known): EffectsView {
  return effects.chain === 'base'
    ? decodeBaseEffects(effects, known)
    : decodeSolanaEffects(effects, known);
}
