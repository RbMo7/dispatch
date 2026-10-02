import type { Chain } from '../domain/chain.js';
import type { BulkCall } from '../domain/dispatch.js';
import type { DispatchItem } from '../domain/call.js';
import type { Dispatch } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { RelayDispatch } from '../domain/relay-dispatch.js';
import type { Transaction } from '../domain/transaction.js';

export type NewDispatchInput<C extends Chain = Chain> = {
  chain: C;
  idempotencyKey: string;
  items: DispatchItem<C>[];
  retryPolicy: boolean;
  /** #11: omitted (or null) for the default one-transaction-per-item mode. */
  bulkCall?: BulkCall | null;
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
 * #57: every work queue below takes the `chains` the caller can act on and
 * never returns a row for any other chain. A chain removed from
 * ENABLED_CHAINS keeps its rows exactly as they are until it is enabled again.
 */
export type ChainScope = readonly Chain[];

/**
 * The Coordinator's — and the API's — only way to touch persistence
 * (ADR-0011): a small, domain-shaped seam so orchestration logic can be
 * tested against InMemoryDispatchStore instead of a real database.
 */
export interface DispatchStore {
  /** Idempotent create (ADR-0021): resubmitting an existing idempotencyKey returns the original Dispatch. */
  createDispatch<C extends Chain>(input: NewDispatchInput<C>): Promise<Dispatch<C>>;
  getDispatch(id: string): Promise<Dispatch | null>;
  /** All Transactions created so far for a Dispatch's Calls — what a status response (docs/api.md) is built from. */
  listTransactions(dispatchId: string): Promise<Transaction[]>;
  /** Atomically claims up to `limit` queued Dispatches for the worker to process (ADR-0009). */
  claimQueued(chains: ChainScope, limit: number): Promise<Dispatch[]>;
  /** Up to `limit` still-PENDING Transactions, least-recently-polled first (never-polled first, then oldest-broadcast), stamping each returned row's `lastCheckedAt` — so successive calls rotate through the whole pending set rather than re-polling the same long-pending rows forever (#21). The Coordinator's own work queue for status-checking and the ABANDONED timeout, across every Dispatch. */
  listPendingTransactions(chains: ChainScope, limit: number): Promise<Transaction[]>;
  /** issue 10: up to `limit` ABANDONED Transactions whose `abandonedAt` is no earlier than `notAbandonedBefore`, oldest-abandoned first — the Coordinator's own low-frequency re-watch work queue, deliberately separate from listPendingTransactions so its own (much slower) poll cadence governs how often ABANDONED work gets touched at all. A Transaction abandoned before `notAbandonedBefore` (outside the bounded window) is excluded — the engine has genuinely stopped watching it, permanently. */
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
  /** #57: per chain in `chains`, how many queued Dispatches, queued Relay Dispatches and PENDING Transactions are waiting. A chain with none is absent. */
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
  markAbandoned(transactionId: string): Promise<void>;
  markFailed(transactionId: string, error: DispatchError): Promise<void>;
  markConfirmed(transactionId: string): Promise<void>;
  /** base-chain-handler issue 07: a re-check found the receipt gone — reopens a CONFIRMED Transaction back to PENDING (clearing confirmedAt) so it re-enters the normal poll/abandonment lifecycle, rather than being left silently wrong. */
  reopenTransaction(transactionId: string): Promise<void>;

  /** Idempotent create (ADR-0021), mirroring createDispatch — a Relay Dispatch's own table (ADR-0031), never squeezed into `dispatches`. */
  createRelayDispatch<C extends Chain>(input: NewRelayDispatchInput<C>): Promise<RelayDispatch<C>>;
  getRelayDispatch(id: string): Promise<RelayDispatch | null>;
  /** Atomically claims up to `limit` queued RelayDispatches for the worker to process, mirroring claimQueued. */
  claimQueuedRelayDispatches(chains: ChainScope, limit: number): Promise<RelayDispatch[]>;
  /** Records which Transaction a RelayDispatch's single broadcast attempt produced — success or failure alike (recordCallFailure and createTransaction both already produce a Transaction id). */
  setRelayDispatchTransaction(relayDispatchId: string, transactionId: string): Promise<void>;
}
