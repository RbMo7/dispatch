import type { Chain } from '../domain/chain.js';
import type { BulkCall } from '../domain/dispatch.js';
import type { DispatchItem } from '../domain/call.js';
import type { Dispatch } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type {
  FlagRule,
  FlagRuleSpec,
  FlagRuleVersion,
  Hold,
  RuleMatch,
} from '../domain/flag-rule.js';
import type { OperatorAction, OperatorActor } from '../domain/operator-action.js';
import type { AssetAmount, Proposal } from '../domain/proposal.js';
import type { RelayDispatch } from '../domain/relay-dispatch.js';
import type { Attempt, Transaction } from '../domain/transaction.js';
import type { SignerPins } from '../signer/client.js';

/** ADR-0054: a multisig Call claimed, validated and funded, to be written down as `UNPROPOSED`. */
export type NewUnproposedInput = {
  dispatchId: string;
  callIndex: number;
  chain: Chain;
};

/**
 * ADR-0054/0041: a Proposal written down before it is sent. `transactionIds`
 * are the Dispatch's `UNPROPOSED` Transactions it holds, in position order.
 * Everything else about the row starts at its defaults (phase `noted`,
 * approvals 0, `nextCheckAt` now).
 */
export type NewProposalInput = Pick<
  Proposal,
  | 'dispatchId'
  | 'chain'
  | 'senderAddress'
  | 'chainRef'
  | 'payload'
  | 'proposalRef'
  | 'sequence'
  | 'threshold'
  | 'deadlineAt'
  | 'executeAfter'
  | 'proposeSignedBytes'
  | 'proposeHash'
  | 'expected'
  | 'committed'
> & { transactionIds: string[] };

/** What the watch loop may change on a Proposal; identity (chain, ref, payload, expected) is fixed at creation. */
export type ProposalPatch = Partial<
  Pick<
    Proposal,
    | 'phase'
    | 'approvalState'
    | 'approvals'
    | 'threshold'
    | 'executeAfter'
    | 'timedOutAt'
    | 'resolvedAt'
    | 'closeState'
    | 'nextCheckAt'
    | 'checkFailures'
    | 'proposeSignedBytes'
    | 'proposeHash'
    | 'committed'
  >
>;

/** How a Proposal's Calls end. ABANDONED also moves the Proposal to `timed_out`; CONFIRMED and FAILED resolve it. */
export type ProposalOutcome = {
  status: 'CONFIRMED' | 'FAILED' | 'ABANDONED';
  /** The structured reason (FAILED: APPROVAL_REJECTED or a chain error; ABANDONED: APPROVAL_TIMEOUT). Cleared on CONFIRMED. */
  error?: DispatchError | null;
  /** The hash that executed it, when known (e.g. a late execution by someone else). Omitted leaves each Call's hash alone. */
  hash?: string | null;
};

/** Whose balance a committed amount is held against: the multisig Sender, or the key that pays the engine's own costs. */
export type CommittedHolder = 'sender' | 'proposer';

/**
 * ADR-0056: how a cancel ended. `already_cancelled` is a repeat, not an
 * error; `already_claimed` when the worker's claim won, whatever has
 * happened since.
 */
export type CancelOutcome = 'cancelled' | 'already_cancelled' | 'already_claimed' | 'not_found';

export type NewDispatchInput<C extends Chain = Chain> = {
  chain: C;
  idempotencyKey: string;
  items: DispatchItem<C>[];
  retryPolicy: boolean;
  /** #11: omitted (or null) for the default one-transaction-per-item mode. */
  bulkCall?: BulkCall | null;
  /** ADR-0058: non-empty stores the Dispatch `held`, with these matches, in the same write. */
  hold?: RuleMatch[];
};

export type NewTransactionInput = {
  dispatchId: string;
  /** Position of the Call within its Dispatch's items this Transaction executes. */
  callIndex: number;
  chain: Chain;
  signedBytes: string;
  hash: string;
};

export type NewFailedCallInput = {
  dispatchId: string;
  /** Position of the Call within its Dispatch's items this Transaction executes. */
  callIndex: number;
  chain: Chain;
  error: DispatchError;
};

export type NewRelayDispatchInput<C extends Chain = Chain> = {
  chain: C;
  idempotencyKey: string;
  signedTransaction: string;
};

/**
 * #110: where a listing page ends, newest first. `createdAt` is the row's
 * exact stored time (ISO 8601, UTC), finer than a Date holds, so the next
 * page starts exactly after it.
 */
export type DispatchCursor = { createdAt: string; id: string };

export function compareNewestFirst(a: DispatchCursor, b: DispatchCursor): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export type DispatchListQuery = {
  after: DispatchCursor | null;
  limit: number;
  chain?: Chain;
  mode?: 'managed' | 'relay';
  storedStatuses?: readonly ('queued' | 'held' | 'broadcasting' | 'cancelled')[];
  from?: Date;
  to?: Date;
};

/** ADR-0057: a page of operator actions, newest first, cut on `(at, id)` like the Dispatch listing. */
export type OperatorActionQuery = { after: DispatchCursor | null; limit: number };

export type ListedOperatorAction = { action: OperatorAction; cursor: DispatchCursor };

export type ListedDispatch = { transactions: Transaction[]; cursor: DispatchCursor } & (
  { mode: 'managed'; dispatch: Dispatch } | { mode: 'relay'; dispatch: RelayDispatch }
);

/**
 * #57: every work queue below takes the `chains` the caller can act on and
 * never returns a row for any other chain. A chain removed from
 * ENABLED_CHAINS keeps its rows exactly as they are until it is enabled again.
 */
export type ChainScope = readonly Chain[];

/** ADR-0059: what the worker last read from the Signer about one Sender key. `error` is a fixed message, never what the Signer said. */
export type SignerKeyRecord = {
  chain: Chain;
  address: string;
  read: { pins: SignerPins } | { error: string };
  readAt: Date;
};

/**
 * The Coordinator's — and the API's — only way to touch persistence
 * (ADR-0011): a small, domain-shaped seam so orchestration logic can be
 * tested against InMemoryDispatchStore instead of a real database.
 */
export interface DispatchStore {
  /** Idempotent create (ADR-0021): resubmitting an existing idempotencyKey returns the original Dispatch. */
  createDispatch<C extends Chain>(input: NewDispatchInput<C>): Promise<Dispatch<C>>;
  getDispatch(id: string): Promise<Dispatch | null>;
  /** All Transactions created so far for a Dispatch's Calls — what a status response (docs/openapi.yaml) is built from. */
  listTransactions(dispatchId: string): Promise<Transaction[]>;
  /** #109: every Attempt (rebroadcast) of every Transaction of a Dispatch or Relay Dispatch, oldest first. */
  listAttempts(dispatchId: string): Promise<Attempt[]>;
  /** Atomically claims up to `limit` queued Dispatches for the worker to process (ADR-0009). Never a cancelled one. */
  claimQueued(chains: ChainScope, limit: number): Promise<Dispatch[]>;
  /**
   * ADR-0056: cancels the Managed or Relay Dispatch `id` if it is still
   * unclaimed (`queued` or `held`), in one conditional write against the claim, so a cancel and
   * a claim can never both win. A cancel that lands records its operator
   * action in the same write (ADR-0057); a repeat records nothing.
   */
  cancelDispatch(id: string, actor: OperatorActor): Promise<CancelOutcome>;
  listOperatorActions(query: OperatorActionQuery): Promise<ListedOperatorAction[]>;

  // --- Flag Rules (ADR-0058). Each write records its operator action in the same write (ADR-0057). ---

  /** Writes version 1. */
  createFlagRule(spec: FlagRuleSpec, actor: OperatorActor): Promise<FlagRule>;
  /** Writes the next version; the earlier ones stay as they were. */
  updateFlagRule(
    id: string,
    spec: FlagRuleSpec,
    actor: OperatorActor,
  ): Promise<FlagRule | 'not_found' | 'deleted'>;
  /** Marks it deleted, keeping every version. A repeat is `deleted: false` and records nothing. */
  deleteFlagRule(
    id: string,
    actor: OperatorActor,
  ): Promise<{ rule: FlagRule; deleted: boolean } | 'not_found'>;
  /** Deleted rules included. */
  getFlagRule(id: string): Promise<FlagRule | null>;
  /** Every rule not deleted, oldest first. */
  listFlagRules(): Promise<FlagRule[]>;
  /** The current version of every rule on `chain` that is enabled and not deleted. */
  listEnabledFlagRules(chain: Chain): Promise<FlagRuleVersion[]>;
  /** Of `recipients` (by `addressKey`), those with a CONFIRMED payment on `chain`, each with when it first confirmed. */
  firstConfirmedPayments(chain: Chain, recipients: string[]): Promise<Map<string, Date>>;
  /** Per asset of `assets`, the smallest-unit total of payments in `chain`'s Managed Dispatches created since `since` and not cancelled. */
  acceptedVolume(chain: Chain, assets: string[], since: Date): Promise<Map<string, bigint>>;
  /** #119: up to `limit` of `chain`'s Managed Dispatches created at or after `since`, newest first, whatever their status. */
  listManagedDispatchesSince(chain: Chain, since: Date, limit: number): Promise<Dispatch[]>;
  /** ADR-0058: why the Dispatch was held, or null if it never was. */
  getHold(dispatchId: string): Promise<Hold | null>;
  /**
   * ADR-0058: moves a held Dispatch to `queued`, recording the release on its
   * hold and as an operator action, in one write conditional on `held`. A
   * cancel is conditional on the same row, so of a release and a cancel
   * racing on a held Dispatch exactly one takes it out of `held`.
   */
  releaseDispatch(id: string, reason: string): Promise<'released' | 'not_held' | 'not_found'>;
  /** Up to `limit` still-PENDING Transactions, least-recently-polled first (never-polled first, then oldest-broadcast), stamping each returned row's `lastCheckedAt` — so successive calls rotate through the whole pending set rather than re-polling the same long-pending rows forever (#21). The Coordinator's own work queue for status-checking and the ABANDONED timeout, across every Dispatch. */
  listPendingTransactions(chains: ChainScope, limit: number): Promise<Transaction[]>;
  /** issue 10 (a Transaction with no hash — a timed-out Proposal's Call, ADR-0054 — is never returned: this queue re-checks sent bytes, and it has none): up to `limit` ABANDONED Transactions whose `abandonedAt` is no earlier than `notAbandonedBefore`, oldest-abandoned first — the Coordinator's own low-frequency re-watch work queue, deliberately separate from listPendingTransactions so its own (much slower) poll cadence governs how often ABANDONED work gets touched at all. A Transaction abandoned before `notAbandonedBefore` (outside the bounded window) is excluded — the engine has genuinely stopped watching it, permanently. */
  listAbandonedTransactions(
    chains: ChainScope,
    limit: number,
    notAbandonedBefore: Date,
  ): Promise<Transaction[]>;
  /** base-chain-handler issue 07: up to `limit` of `chain`'s CONFIRMED Transactions (per chain, so one chain's volume never crowds another's out of `limit`) whose `confirmedAt` is no earlier than `notConfirmedBefore`, oldest-confirmed first — the reorg safety net's own low-frequency re-watch work queue, mirroring listAbandonedTransactions's shape exactly. A Transaction confirmed before `notConfirmedBefore` (outside the bounded re-check window) is excluded — it's aged past the point this engine still bothers re-verifying it. */
  listRecentlyConfirmedTransactions(
    chain: Chain,
    limit: number,
    notConfirmedBefore: Date,
  ): Promise<Transaction[]>;
  /** #57: per chain in `chains`, how many queued Dispatches, queued Relay Dispatches and PENDING Transactions are waiting — and, for a multisig chain (ADR-0054), Calls `UNPROPOSED` or `AWAITING_APPROVAL`, which wait on a chain just the same. A chain with none is absent. */
  countWaitingWork(chains: ChainScope): Promise<Map<Chain, number>>;
  /** Persists a Call's freshly-signed Transaction — #20 (ADR-0041): written down *before* it is ever sent. */
  createTransaction(input: NewTransactionInput): Promise<Transaction>;
  /** #20 review: every member of one bundled broadcast, written down in one atomic step — a crash can never leave a bundle half-recorded. */
  createTransactions(inputs: NewTransactionInput[]): Promise<Transaction[]>;
  /** #20 review: every Transaction for `chain` that is PENDING or REPLACED — what a restarted Chain Handler must never hand a nonce out over. */
  listUnsettledTransactions(chain: Chain): Promise<Transaction[]>;
  /** #20 review: re-stamps these Dispatches' claims as live — a heartbeat, so a slow batch is never mistaken for a crashed one. */
  touchClaims(dispatchIds: string[]): Promise<void>;
  /** Persists a Call that failed before ever reaching a broadcast (validateCall/prepare/sign) — no hash/signedBytes exist yet, unlike createTransaction. */
  recordCallFailure(input: NewFailedCallInput): Promise<Transaction>;
  /** Records a re-broadcast of a Transaction's exact signed bytes — a new Attempt of the same Transaction, with the send's `error` if the chain refused it (e.g. "already known"). Updates `lastBroadcastAt` either way: a refused send is still a send, for the stuck timer. */
  recordBroadcast(transactionId: string, hash: string, error?: DispatchError): Promise<void>;
  /** #9 (ADR-0037): atomically persists a fee-bump replacement of `predecessorId` — a new PENDING Transaction for the same Call (same dispatchId/callIndex/chain), `replacesTransactionId` set, `feeBumpAttempts` one more than the predecessor's — and marks the predecessor REPLACED. */
  createReplacementTransaction(
    predecessorId: string,
    replacement: { signedBytes: string; hash: string },
  ): Promise<Transaction>;
  /** #9: every Transaction carrying `hash` — more than one when a bundled broadcast covered several Calls. */
  listTransactionsByHash(hash: string): Promise<Transaction[]>;
  /** #9: records a failed (or exhausted) fee-bump attempt against the cap without creating a replacement. */
  setFeeBumpAttempts(transactionId: string, feeBumpAttempts: number): Promise<void>;
  /** #20 (ADR-0041): a Transaction written down before sending was actually sent — stamps lastBroadcastAt, and takes the hash the chain reported if it differs (Solana re-signing with a fresh blockhash). */
  recordSent(transactionId: string, hash: string): Promise<void>;
  /** #20: a fee-bump replacement written down before sending was refused — it becomes DROPPED, and its predecessor PENDING again. */
  undoReplacement(replacementId: string): Promise<void>;
  /** #20: Dispatches still `broadcasting` whose claim is older than `claimedBefore` (or was never stamped) and that still have items with no Transaction (so were never sent) — re-stamped as claimed now, so each is reclaimed by one worker at a time. */
  reclaimStaleDispatches(
    chains: ChainScope,
    claimedBefore: Date,
    limit: number,
  ): Promise<Dispatch[]>;
  /** #20: the same for Relay Dispatches with no Transaction row at all (not merely an unwritten link). */
  reclaimStaleRelayDispatches(
    chains: ChainScope,
    claimedBefore: Date,
    limit: number,
  ): Promise<RelayDispatch[]>;
  /** #9: another version at the same nonce settled this Transaction's Call — it can never land. */
  markDropped(transactionId: string): Promise<void>;
  /** `error` (ADR-0053's APPROVAL_TIMEOUT) is recorded when given; omitted leaves the row's error untouched, as before. */
  markAbandoned(transactionId: string, error?: DispatchError): Promise<void>;
  markFailed(transactionId: string, error: DispatchError): Promise<void>;
  markConfirmed(transactionId: string): Promise<void>;
  /** base-chain-handler issue 07: a re-check found the receipt gone — reopens a CONFIRMED Transaction back to PENDING (clearing confirmedAt) so it re-enters the normal poll/abandonment lifecycle, rather than being left silently wrong. */
  reopenTransaction(transactionId: string): Promise<void>;

  // --- Multisig approval (ADR-0054). Only a Chain Handler with an approval capability ever reaches these. ---

  /**
   * Writes each Call down as an `UNPROPOSED` Transaction (no hash, no bytes).
   * Idempotent per (dispatchId, callIndex): a Call already written down is
   * returned as it is, so a reclaimed Dispatch never gets a duplicate row.
   */
  noteUnproposed(inputs: NewUnproposedInput[]): Promise<Transaction[]>;
  /** `chain`'s `UNPROPOSED` Transactions, first-claimed Dispatch first and by `callIndex` within one, so the caller can propose one Dispatch at a time. */
  listUnproposed(chain: Chain, limit: number): Promise<Transaction[]>;
  /**
   * Atomically writes a Proposal at phase `noted` and moves its Transactions
   * from `UNPROPOSED` to `AWAITING_APPROVAL`, setting `proposalId` and
   * `proposalPosition` (the index in `transactionIds`). All-or-nothing: throws,
   * changing nothing, if any Transaction is missing, is not `UNPROPOSED`, or
   * belongs to another Dispatch or chain (a Proposal never mixes Dispatches),
   * or if `proposalRef` (or, on Solana, the sender's `sequence`) is taken.
   */
  createProposal(input: NewProposalInput): Promise<Proposal>;
  getProposal(id: string): Promise<Proposal | null>;
  /**
   * How many of `senderAddress`'s Proposals on `chain` are open in the sense
   * of a chain's `openProposalLimit`: phase `noted`, `open` or `executing`.
   * A `timed_out` Proposal no longer holds a slot (ADR-0053: its Calls are
   * already ABANDONED), nor does a `resolved` one.
   */
  countOpenProposals(chain: Chain, senderAddress: string): Promise<number>;
  /**
   * Whether `senderAddress` has a Proposal still `noted`: written down but not yet
   * confirmed sent. It holds the next sequence (a Squads index, a Safe nonce), so
   * proposing again before it is confirmed would build a second one on the same
   * sequence and collide with it.
   */
  hasNotedProposal(chain: Chain, senderAddress: string): Promise<boolean>;
  /**
   * The highest `sequence` among `senderAddress`'s Proposals on `chain` that
   * have a CONFIRMED Call, or null when none: the engine's own knowledge of
   * the last sequence (Safe nonce) known to be consumed. Only a CONFIRMED
   * execution counts: a reverted execute leaves a Safe's nonce unchanged
   * (stale-nonce guard, #84).
   */
  highestConfirmedSequence(chain: Chain, senderAddress: string): Promise<number | null>;
  /** Unresolved Proposals on `chains` whose `nextCheckAt` is no later than `now`, most overdue first. Does not stamp them: the watcher reschedules with `updateProposal`. */
  listProposalsDue(chains: ChainScope, now: Date, limit: number): Promise<Proposal[]>;
  /** Proposals on `chains` whose `closeState` is `pending`: finished, but the chain has not yet been asked successfully to close them. Oldest first. */
  listProposalsAwaitingClose(chains: ChainScope, limit: number): Promise<Proposal[]>;
  /** A Proposal's Calls in position order, one Transaction per Call (never a REPLACED or DROPPED version). */
  listProposalCalls(proposalId: string): Promise<Transaction[]>;
  updateProposal(id: string, patch: ProposalPatch): Promise<Proposal>;
  /**
   * ADR-0041 for the execute transaction: atomically sets phase `executing`
   * and moves the Proposal's `AWAITING_APPROVAL` Calls to `PENDING`, all
   * sharing `hash` and `signedBytes` like a bundle, before anything is sent.
   */
  markProposalExecuting(
    proposalId: string,
    signedBytes: string,
    hash: string,
  ): Promise<Transaction[]>;
  /**
   * A failed execute of a Proposal that can still execute (ADR-0053): atomically
   * sets phase back to `open`, due now, and returns its `PENDING` or `FAILED`
   * Calls to `AWAITING_APPROVAL` with no hash, bytes or error. The failed
   * send stays in each Call's Attempts.
   */
  reopenProposalForExecution(proposalId: string): Promise<Transaction[]>;
  /**
   * Atomically ends a Proposal: sets every one of its Calls (current versions)
   * to `outcome.status` with the error and hash, and the Proposal to
   * `timed_out` (ABANDONED, stamping `abandonedAt`/`timedOutAt`) or `resolved`
   * (stamping `confirmedAt` for CONFIRMED, `resolvedAt`). Also used to settle a
   * `timed_out` Proposal's Calls later (ADR-0053's late execution).
   */
  settleProposal(proposalId: string, outcome: ProposalOutcome): Promise<Transaction[]>;
  /**
   * What `chain`'s Proposals still hold back from `holder`'s balance, per asset
   * (the Funding Check subtracts it): the `committed` of Proposals that are
   * `noted`, `open` or `executing`, or `timed_out` since `timedOutSince` or
   * later (ADR-0053); for `sender`, also the payments of `UNPROPOSED` Calls.
   */
  listCommitted(chain: Chain, holder: CommittedHolder, timedOutSince: Date): Promise<AssetAmount[]>;
  /** Every Proposal that holds one of the Dispatch's Calls, oldest first — what `GET /v1/dispatch/:id` builds the `approval` block from. */
  listProposalsForDispatch(dispatchId: string): Promise<Proposal[]>;

  /** Idempotent create (ADR-0021), mirroring createDispatch — a Relay Dispatch's own table (ADR-0031), never squeezed into `dispatches`. */
  createRelayDispatch<C extends Chain>(input: NewRelayDispatchInput<C>): Promise<RelayDispatch<C>>;
  getRelayDispatch(id: string): Promise<RelayDispatch | null>;
  listDispatches(query: DispatchListQuery): Promise<ListedDispatch[]>;
  /** Atomically claims up to `limit` queued RelayDispatches for the worker to process, mirroring claimQueued. */
  claimQueuedRelayDispatches(chains: ChainScope, limit: number): Promise<RelayDispatch[]>;
  /** Records which Transaction a RelayDispatch's single broadcast attempt produced — success or failure alike (recordCallFailure and createTransaction both already produce a Transaction id). */
  setRelayDispatchTransaction(relayDispatchId: string, transactionId: string): Promise<void>;
  /** ADR-0059: replaces whatever was recorded for the record's chain and address. */
  recordSignerKey(record: SignerKeyRecord): Promise<void>;
  getSignerKey(chain: Chain, address: string): Promise<SignerKeyRecord | null>;
}
