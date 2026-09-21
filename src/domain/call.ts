import type { Chain } from './chain.js';

export type SolanaAccountMeta = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type EvmCall = {
  to: string;
  data: string;
  value: string;
};

export type SolanaCall = {
  programId: string;
  accounts: SolanaAccountMeta[];
  data: string;
};

/**
 * The primitive a Chain Handler's prepare() consumes (ADR-0018) — opaque,
 * caller-encoded data plus the destination shape that chain family expects,
 * exactly as pinned in docs/api.md: {to,data,value} on evm, {programId,
 * accounts,data} on solana, with no chain tag of its own (a Dispatch's own
 * `chain` already says which shape its items are). A Payment is translated
 * into a Call at the API layer; a Chain Handler never sees Payment.
 */
export type Call = EvmCall | SolanaCall;

/** Which Call shape a given chain family uses — distributes over a Chain union. */
export type CallForChain<C extends Chain> = C extends 'evm' ? EvmCall : SolanaCall;

export type Payment = {
  recipient: string;
  asset: string;
  amount: string;
};
