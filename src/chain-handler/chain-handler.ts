import type { CallForChain } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { DispatchError } from '../domain/errors.js';
import type { Result } from '../domain/result.js';

/**
 * Opaque to everything outside the Chain Handler that produced it (issue 05,
 * mirroring the reference implementation's `unsignedTransaction: unknown`
 * pattern) — the engine core never inspects, serializes, or assumes
 * anything about its shape. Only the Chain Handler that built it, and the
 * Signer it hands the serialized bytes to, ever look inside.
 */
export type UnsignedTransaction = unknown;

/** Opaque in the same way as UnsignedTransaction — only the Chain Handler that produced it knows its shape. */
export type SignedTransaction = unknown;

export type PreparedTransaction = {
  /** Position of the Call within the array `prepare` was given — matches Transaction.callIndex (CONTEXT.md). */
  callIndex: number;
  unsignedTransaction: UnsignedTransaction;
};

export type BroadcastResult = {
  hash: string;
};

export type Balance = {
  asset: string;
  amount: string;
};

/**
 * On-chain outcomes only — deliberately narrower than domain's
 * TransactionStatus. `ABANDONED` (ADR-0004) is the Coordinator's own
 * decision about whether the engine is still watching a transaction, never
 * something a Chain Handler observes on-chain, so it isn't a value this
 * interface can return.
 */
export type ChainStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

/**
 * The chain-specific plugin seam (CONTEXT.md, ADR-0015): one implementation
 * per chain family, built so that adding a new one never requires changing
 * the Coordinator, the Signer contract, or another Chain Handler. Every
 * transaction payload this interface passes is opaque
 * (UnsignedTransaction/SignedTransaction) — nothing here may assume an
 * EVM- or Solana-shaped transaction. A Chain Handler never calls a Signer
 * or holds key material itself (ADR-0002); `sign` delegates to whichever
 * SignerClient the concrete implementation was constructed with.
 */
export interface ChainHandler<C extends Chain = Chain> {
  readonly chain: C;

  /**
   * Cheap shape validation only (a malformed recipient/program id, wrong
   * account arity) — never an RPC round-trip. A Chain Handler only ever
   * validates Call (ADR-0018): Payment is translated to Call at the API
   * layer before anything reaches this interface. Must never mutate `call`.
   */
  validateCall(call: CallForChain<C>): Promise<Result<void, DispatchError>>;

  /**
   * Builds one unsigned transaction per input Call, in the same order —
   * result[i] answers for items[i] via its callIndex. Must never mutate
   * `items`.
   */
  prepare(
    items: CallForChain<C>[],
    senderAddress: string,
  ): Promise<Result<PreparedTransaction[], DispatchError>>;

  /**
   * Delegates to the Signer client (ADR-0002) — the Chain Handler is the
   * only thing that knows how to turn its own opaque UnsignedTransaction
   * into signer request bytes, and how to fold the returned signature back
   * into a signed transaction.
   */
  sign(
    prepared: PreparedTransaction,
    senderAddress: string,
  ): Promise<Result<SignedTransaction, DispatchError>>;

  /** A rejected/unreachable broadcast is a structured DispatchError (ADR-0010), never a thrown exception. */
  broadcast(signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>>;

  /** Never reports CONFIRMED for a hash that hasn't actually confirmed on-chain, including one never broadcast. */
  getStatus(hash: string): Promise<Result<ChainStatus, DispatchError>>;

  /** What the Coordinator's Funding Check (ADR-0024) compares a claimed batch's required amount against. */
  getBalance(address: string, asset: string): Promise<Result<Balance, DispatchError>>;
}
