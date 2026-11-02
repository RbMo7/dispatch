import type { Chain } from './chain.js';
import type { TokenKind } from './operator-action.js';

/** What explains calls to a contract: its ABI on Base, its Anchor IDL on Solana, stored as given. */
export type ContractDefinitionByChain = {
  base: { abi: unknown[] };
  solana: { idl: Record<string, unknown> };
};

/** A contract an operator registers from the console: where it is, what to call it, and how to read it. */
export type NewKnownContract<C extends Chain = Chain> = {
  [K in C]: { chain: K; address: string; label: string } & ContractDefinitionByChain[K];
}[C];

/**
 * ADR-0063: one row of the `known_contracts` registry. Disabled, never
 * deleted; at most one enabled row per address, so a wrong ABI is replaced by
 * disabling it and adding the right one.
 */
export type KnownContract<C extends Chain = Chain> = NewKnownContract<C> & {
  id: string;
  /** Every row today is an operator's; the column leaves room for configured ones, as Known Assets have. */
  source: 'console';
  addedBy: TokenKind;
  addedAt: Date;
  enabled: boolean;
};

export const CONTRACT_LABEL_MAX = 64;
