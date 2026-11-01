import type { CallForChain, DispatchItem, Payment } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { BulkCall } from '../domain/dispatch.js';
import type { NewKnownAsset } from '../domain/known-asset.js';
import type { DispatchError } from '../domain/errors.js';
import type {
  ChainProposalRef,
  CommittedAmounts,
  ExpectedTotals,
  Proposal,
} from '../domain/proposal.js';
import type { Result } from '../domain/result.js';

/**
 * Opaque to everything outside the Chain Handler that produced it
 * (ADR-0027) — a serialized byte string (e.g. base64) whose internal
 * structure only that Chain Handler understands; the engine core never
 * decodes or assumes anything EVM- or Solana-shaped about it. Typed as
 * `string` rather than `unknown` because it has to actually travel
 * somewhere un-opaquely: `sign` turns it into the chain's own unsigned
 * serialization and hands that to the Signer client as base64
 * `unsignedTransaction` (ADR-0046), string-typed end to end.
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

/**
 * ADR-0061: what the chain says about a token address an operator wants to
 * add. `symbol` and `name` are empty when the token publishes none.
 * `supply` is in the token's smallest unit.
 */
export type TokenRead<C extends Chain = Chain> = NewKnownAsset<C> & { supply: string };

/** Why an address can't be a Known Asset: it isn't a token, the engine can't pay it out, or the chain could not be read. */
export type TokenReadError = {
  code: 'NOT_A_TOKEN' | 'NOT_PAYABLE' | 'RPC_UNAVAILABLE';
  message: string;
};

/** Reads one token's decimals, name, symbol and supply from the chain. */
export type ReadToken<C extends Chain = Chain> = (
  address: string,
) => Promise<Result<TokenRead<C>, TokenReadError>>;

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
 * ADR-0054: a Proposal as the Chain Handler built it, before it is signed or
 * written down. Everything the engine persists about the Proposal that only
 * the chain can know. `payload` is opaque (ADR-0027) and handler-owned: enough
 * to re-sign, re-post or execute it later.
 */
export type BuiltProposal = {
  chainRef: ChainProposalRef;
  /** The proposal's own address (Squads PDA) or `safeTxHash`; unique, so a re-post is idempotent. */
  proposalRef: string;
  payload: string;
  /** Squads `transactionIndex`, Safe nonce. */
  sequence: number | null;
  /** Approvals needed, as the multisig stands now. */
  threshold: number;
  /** The multisig's time lock, when it has one. */
  executeAfter: Date | null;
  /** What it should pay out, from the Dispatch's own items (a mistake-catcher, never a control). */
  expected: ExpectedTotals;
  /** What it holds back from the Sender and the proposer until it is closed (rent included). */
  committed: CommittedAmounts;
};

/** ADR-0054: the signed propose transaction (or signed Safe message), exactly what is persisted before it is sent. */
export type SignedProposal = {
  /** Opaque, handler-owned; kept as `proposeSignedBytes` so a crash re-sends the same bytes. */
  signedBytes: string;
  hash: string;
};

/** ADR-0054: what the chain says about a Proposal right now, for the watch loop (a later ticket). */
export type ProposalSnapshot = {
  status: 'unknown' | 'active' | 'approved' | 'rejected' | 'executed' | 'cancelled' | 'stale';
  approvals: number;
  threshold: number;
  executeAfter?: Date;
  /** Set when the status is `executed`: the hash that executed it. */
  executedHash?: string;
  /** Approved, past its time lock, and able to execute right now. */
  executable: boolean;
};

/** ADR-0054: what proposing costs the key that pays for it, beyond any payment. */
export type ApprovalCost = {
  asset: string;
  /** Fees and rent paid, smallest unit. */
  amount: string;
  /** The part of `amount` that is rent, returned only when the Proposal is closed. */
  rentLocked: string;
};

/**
 * ADR-0054, optional: only a chain with a multisig Sender implements it —
 * its presence is the capability, like `prepareReplacement` (ADR-0037) and
 * `validateBulkCall` (ADR-0038). It carries the chain-specific work only;
 * the state machine (claiming, funding, the deadline, settling) is the
 * Coordinator's `ApprovalFlow`. The engine never approves (ADR-0049): a
 * vault or Safe never signs here — `signProposal` is signed by the
 * `proposerAddress`, not by the Sender.
 */
export interface ApprovalCapability<C extends Chain = Chain> {
  /**
   * What the Funding Check calls each balance when it names the short one
   * (`chainDetail.holder`): Solana `vault` / `memberKey`, Base `safe` / `executor`.
   */
  readonly holders: { sender: 'vault' | 'safe'; proposer: 'memberKey' | 'executor' };
  /** The key that proposes (and executes): a Squads member or a Safe delegate/executor. */
  readonly proposerAddress: string;
  /** How many Proposals may be open per Sender: Squads `Infinity` (creation is serialized), Safe 1. */
  readonly openProposalLimit: number;
  /** How often the watch loop reads one of this chain's open Proposals, in ms (default 15 s; Safe 60 s, for the Safe service's quota). */
  readonly watchIntervalMs?: number;

  /**
   * Pure and size-aware: how one Dispatch's Calls split into Proposals.
   * Returns each Proposal's Call positions (indexes into `calls`), every
   * index exactly once. Only ever given one Dispatch's Calls (ADR-0054). A
   * structured error fails every one of those Calls.
   */
  planBundles(calls: CallForChain<C>[]): Result<number[][], DispatchError>;
  /** Builds one Proposal from one bundle of one Dispatch's Calls, for `sender` (the vault or Safe). */
  buildProposal(input: {
    calls: CallForChain<C>[];
    sender: string;
    /**
     * Optional, Safe only (#84): the lowest sequence the Proposal may take, the engine's own
     * knowledge of what is already consumed (last CONFIRMED sequence + 1). A chain read right
     * after an execution can still be stale; the Proposal then takes `max(chain, minSequence)`.
     * Squads ignores it.
     */
    minSequence?: number;
  }): Promise<Result<BuiltProposal, DispatchError>>;
  /** Signs the propose transaction through the Signer as `proposerAddress`. `SIGNER_REFUSED` is definite; `SIGNER_UNREACHABLE` is retried. */
  signProposal(built: BuiltProposal): Promise<Result<SignedProposal, DispatchError>>;
  /** Sends it: idempotent (Squads broadcast, Safe POST), so re-sending the same bytes is always safe. */
  submitProposal(signed: SignedProposal): Promise<Result<void, DispatchError>>;
  readProposal(ref: ChainProposalRef): Promise<Result<ProposalSnapshot, DispatchError>>;
  /** The execute transaction for an approved Proposal, to be signed and broadcast like any other. */
  prepareExecution(proposal: Proposal): Promise<Result<PreparedTransaction, DispatchError>>;
  estimateApprovalCost(
    calls: CallForChain<C>[],
    sender: string,
  ): Promise<Result<ApprovalCost, DispatchError>>;
  /** Optional: reclaims what a finished Proposal still locks (Squads rent). */
  closeProposal?(proposal: Proposal): Promise<Result<void, DispatchError>>;
}

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
   * #42 (ADR-0044), optional: how many of a batch's transactions the
   * Coordinator may send at once. Absent means 1 — one after another, as a
   * chain whose nonces must land in order (Base) needs.
   */
  readonly maxConcurrentSends?: number;

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

  /**
   * #40 (ADR-0043), optional: the native-asset cost of sending these Calls
   * beyond what their payments themselves move — network fees, and on
   * Solana rent for accounts the transactions create. The Funding Check
   * adds it to the Sender's requirement. Estimates may over-ask, never
   * under-ask.
   */
  networkCost?(
    calls: CallForChain<C>[],
    senderAddress: string,
  ): Promise<Result<Balance, DispatchError>>;

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

  /** ADR-0054, optional: present only for a chain with a multisig Sender. See ApprovalCapability. */
  readonly approval?: ApprovalCapability<C>;

  /** What the Coordinator's Funding Check (ADR-0024) compares a claimed batch's required amount against. */
  getBalance(address: string, asset: string): Promise<Result<Balance, DispatchError>>;
}
