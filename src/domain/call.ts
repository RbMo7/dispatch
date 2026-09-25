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
export type CallForChain<C extends Chain> = C extends 'base' ? EvmCall : SolanaCall;

export type Payment = {
  recipient: string;
  asset: string;
  amount: string;
};

/**
 * What a Dispatch actually persists per line item (ADR-0024/ADR-0028): the
 * translated Call the Coordinator executes, plus the original Payment it
 * came from — null for a caller-supplied `call` item. Call alone is opaque
 * (ADR-0018), so this is the only place `asset`/`amount` survive past the
 * API layer's translation; the Funding Check aggregates from `payment`
 * fields here rather than trying to decode them back out of an opaque Call.
 */
export type DispatchItem<C extends Chain = Chain> = {
  call: CallForChain<C>;
  payment: Payment | null;
  /** #11 (ADR-0038): who holds the funds this item spends, when that isn't the Sender — a Bulk Call ERC-20 item spends its aggregator's own balance. Set at the API edge from the Chain Handler's own answer; the Funding Check reads it. */
  fundedBy?: string;
};
