import type { CallForChain, DispatchItem, Payment } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { BulkCall } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { Result } from '../domain/result.js';

/**
 * Opaque to everything outside the Chain Handler that produced it
 * (ADR-0027) — a serialized byte string (e.g. base64) whose internal
 * structure only that Chain Handler understands; the engine core never
 * decodes or assumes anything EVM- or Solana-shaped about it. Typed as
 * `string` rather than `unknown` because it has to actually travel
 * somewhere un-opaquely: `sign` hands it to the Signer client as
 * `unsignedTxBytes` (ADR-0002, itself string-typed end-to-end), so there's
 * no unspecified serialization step to hide behind a wider type.
 */
export type UnsignedTransaction = string;

/**
 * Opaque in the same way as UnsignedTransaction (ADR-0027). Also exactly
 * what gets persisted as Transaction.signedBytes — for every real chain,
 * the bytes `broadcast` sends are the same bytes worth keeping for the
 * record, so there's no separate serialization to invent here either.
 */
export type SignedTransaction = string;

export type PreparedTransaction = {
  /** Position of the Call within the array `prepare` was given — matches Transaction.callIndex (CONTEXT.md). */
  callIndex: number;
  unsignedTransaction: UnsignedTransaction;
};

/** #11 (ADR-0038): what `prepare` may be told beyond the Calls themselves. */
export type PrepareOptions = {
  /** This batch is one Bulk Dispatch's items, to be sent through its aggregator. */
  bulkCall?: BulkCall;
};

/** #11: a Bulk Call request as the caller sent it — `maxBatchSize` not yet defaulted. */
export type BulkCallRequest = { aggregator: string; maxBatchSize?: number; allowFailure?: boolean };

/** #11: a checked Bulk Call — the resolved opt-in, plus who funds each item (null = the Sender). */
export type BulkCallPlan = { bulkCall: BulkCall; fundedBy: (string | null)[] };

/** #11: one bundled item's own outcome, read from its slot in the bundle. */
export type BundleSlotStatus = { status: ChainStatus; detail?: unknown };

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
 *
 * `EXPIRED` (ADR-0042): not yet included, and provably never can be (Solana:
 * its blockhash passed its validity window). Only a chain with such a proof
 * reports it; the Coordinator then resubmits the Calls, or reports FAILED.
 */
export type ChainStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';

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
   * Turns a Payment (ADR-0018's convenience shape) into this chain's Call —
   * a native transfer or a known token-transfer encoding (CONTEXT.md's
   * Payment entry). This is the one piece of real chain-specific knowledge
   * the API layer (issue 08) needs but can't have itself, so it asks
   * whichever Chain Handler is registered for the Dispatch's chain rather
   * than encoding anything chain-shaped on its own (ADR-0028). Must never
   * mutate `payment`.
   */
  paymentToCall(payment: Payment): Promise<Result<CallForChain<C>, DispatchError>>;

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
    options?: PrepareOptions,
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

  /**
   * Cheap shape/signature validation only (a real signature present and
   * cryptographically valid, a fee payer set) — never an RPC round-trip,
   * never semantic or simulation-based understanding of what the
   * transaction does (ADR-0032). The receiving-side counterpart to
   * `validateCall`: a Relay Dispatch transaction arrives already signed by
   * someone else, so there's no Call to validate, only these opaque bytes.
   * A structurally valid transaction that will fail on-chain for its own
   * reasons still gets broadcast and fails there, exactly like a Managed
   * Dispatch Call does. Must never mutate `signed`.
   */
  validateSignedTransaction(signed: SignedTransaction): Promise<Result<void, DispatchError>>;

  /**
   * #20 (ADR-0041): the hash `broadcast` will report for these signed
   * bytes, computed locally — no network — so the Coordinator can write a
   * Transaction down *before* sending it. Must never mutate `signed`.
   */
  transactionHash(signed: SignedTransaction): Result<string, DispatchError>;

  /**
   * #20 review (ADR-0041, ADR-0042), optional: only a handler keeping
   * in-memory state about in-flight transactions needs it. Called once at
   * worker start with the signed bytes of every Transaction still in flight:
   * Base reserves their nonces, so it never hands one out twice; Solana
   * re-learns their blockhashes, so expiry stays provable.
   */
  restoreInFlight?(signed: SignedTransaction[]): Promise<void>;

  /** A rejected/unreachable broadcast is a structured DispatchError (ADR-0010), never a thrown exception. */
  broadcast(signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>>;

  /** Never reports CONFIRMED for a hash that hasn't actually confirmed on-chain, including one never broadcast. */
  getStatus(hash: string): Promise<Result<ChainStatus, DispatchError>>;

  /**
   * #9 (ADR-0037), optional: only a chain that can fee-bump implements it.
   * Given the latest signed bytes of a stuck transaction, returns an
   * unsigned replacement at the same nonce with raised fees, for the
   * Coordinator to `sign` and `broadcast` like any other. A structured
   * `NONCE_ALREADY_USED` when that nonce has already been consumed on-chain.
   * Must never mutate `signed`.
   */
  prepareReplacement?(
    signed: SignedTransaction,
    senderAddress: string,
  ): Promise<Result<PreparedTransaction, DispatchError>>;

  /**
   * #11 (ADR-0038), optional: only a chain with Bulk Call implements it —
   * its presence is the capability. Checks a request's `bulkCall` against
   * its items before anything is persisted, resolving the batch size and
   * who funds each item. A structured error means a `400`.
   */
  validateBulkCall?(
    request: BulkCallRequest,
    items: DispatchItem<C>[],
  ): Promise<Result<BulkCallPlan, DispatchError>>;

  /**
   * #11 (ADR-0038), optional: each bundled item's own outcome, in slot
   * order, for a transaction `prepare` built with a `bulkCall`. PENDING for
   * every slot until the transaction itself resolves — or an empty array
   * while the chain doesn't know the transaction at all yet.
   */
  getBundleStatus?(hash: string): Promise<Result<BundleSlotStatus[], DispatchError>>;

  /** What the Coordinator's Funding Check (ADR-0024) compares a claimed batch's required amount against. */
  getBalance(address: string, asset: string): Promise<Result<Balance, DispatchError>>;
}
