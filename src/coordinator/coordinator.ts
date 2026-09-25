import type { Logger } from 'pino';

import type {
  ChainHandler,
  PreparedTransaction,
  UnsignedTransaction,
} from '../chain-handler/chain-handler.js';
import type { Call } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { Dispatch } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { RelayDispatch } from '../domain/relay-dispatch.js';
import type { Transaction } from '../domain/transaction.js';
import { logger as defaultLogger } from '../logger.js';
import type { DispatchStore } from '../repository/dispatch-store.js';

/** relay-dispatch issue 01: a bounded retry of `broadcast`'s identical bytes on a transient send failure — never a fee-bump, never a new signature (ADR-0005). */
const RELAY_BROADCAST_MAX_ATTEMPTS = 3;
const RELAY_BROADCAST_RETRY_BASE_DELAY_MS = 250;

/**
 * issue 10 (ADR-0004/CONTEXT.md's ABANDONED entry): how long after being
 * marked ABANDONED a Transaction is still worth a low-frequency re-check —
 * "bounded window," not forever. A caller who resent a payment after
 * seeing ABANDONED has, by this point, long since made their own decision;
 * re-watching indefinitely would just be spending RPC calls confirming a
 * fact nobody's still waiting to learn. 24 hours comfortably covers "the
 * transaction was actually still in some mempool and eventually got
 * included," the scenario ADR-0004 exists for, without watching forever.
 */
const DEFAULT_ABANDONED_REWATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only a send-layer hiccup is worth retrying with identical bytes — a genuine on-chain rejection (CHAIN_REJECTED) never becomes true by resending the exact same bytes again. */
function isTransientBroadcastFailure(error: DispatchError): boolean {
  return error.code === 'RPC_UNAVAILABLE';
}

/** A (Dispatch, callIndex) pointer to one Call — the Funding Check's own grouping unit, and issue 13's bundling grouping unit. */
type CallRef = { dispatch: Dispatch; callIndex: number };

type FundingRequirement = {
  chain: Chain;
  asset: string;
  required: bigint;
  items: CallRef[];
};

export type CoordinatorDeps = {
  store: DispatchStore;
  /** Populated by the chain registry (issue 07, `ChainRegistry.handlers`) — a claimed Dispatch naming an unregistered chain is a configuration bug, never a business-relevant outcome, so it's not surfaced as a DispatchError here. */
  chainHandlers: ReadonlyMap<Chain, ChainHandler>;
  /** Deployment config, one Sender wallet per chain (ADR-0016: Sender Pool is deferred — single-Sender ships first). */
  senderAddresses: Map<Chain, string>;
  /** The chain-aware ABANDONED timeout (ADR-0004) — how long a still-PENDING transaction may wait, with Retry Policy off, before the Coordinator stops watching it. */
  abandonmentTimeoutMs: Map<Chain, number>;
  /** issue 10: how long after being marked ABANDONED a Transaction is still eligible for the low-frequency re-watch (see rewatchAbandonedTransactions). Defaults to DEFAULT_ABANDONED_REWATCH_WINDOW_MS. */
  abandonedRewatchWindowMs?: number;
  /**
   * base-chain-handler issue 07: how long after being marked CONFIRMED a
   * Transaction stays eligible for the reorg safety net's low-frequency
   * re-check (see recheckRecentlyConfirmedTransactions) — a fixed,
   * chain-agnostic proxy for "past the point a reorg is credible," rather
   * than any chain-specific "safe head" concept the Coordinator would
   * otherwise need to know about. A chain simply absent from this map
   * (e.g. 'solana', whose own getStatus commitment levels already cover
   * this) is never re-checked at all — defaults to an empty map.
   */
  reorgRecheckWindowMs?: Map<Chain, number>;
  /** Injectable so the ABANDONED timeout is testable without real sleeps. */
  now?: () => Date;
  /** Injectable so relay-dispatch issue 01's broadcast-retry backoff is testable without real sleeps. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to the shared app logger (src/logger.ts) under a `component: 'coordinator'` binding. Injectable so tests/tools can point it elsewhere. */
  logger?: Logger;
};

/**
 * The orchestration core (ADR-0009, CONTEXT.md): claims queued Managed
 * Dispatch work and drives it through validate/prepare/sign/broadcast, then
 * separately polls what's already broadcast to advance it to a terminal
 * state — applying Retry Policy and the chain-aware ABANDONED timeout
 * (ADR-0003/0004) along the way. Holds no chain-specific knowledge at all;
 * everything chain-specific stays behind the ChainHandler interface
 * (issue 05) it's given.
 */
export class Coordinator {
  private readonly store: DispatchStore;
  private readonly chainHandlers: ReadonlyMap<Chain, ChainHandler>;
  private readonly senderAddresses: Map<Chain, string>;
  private readonly abandonmentTimeoutMs: Map<Chain, number>;
  private readonly abandonedRewatchWindowMs: number;
  private readonly reorgRecheckWindowMs: Map<Chain, number>;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;

  constructor(deps: CoordinatorDeps) {
    this.store = deps.store;
    this.chainHandlers = deps.chainHandlers;
    this.senderAddresses = deps.senderAddresses;
    this.abandonmentTimeoutMs = deps.abandonmentTimeoutMs;
    this.abandonedRewatchWindowMs = deps.abandonedRewatchWindowMs ?? DEFAULT_ABANDONED_REWATCH_WINDOW_MS;
    this.reorgRecheckWindowMs = deps.reorgRecheckWindowMs ?? new Map<Chain, number>();
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? sleep;
    this.logger = (deps.logger ?? defaultLogger).child({ component: 'coordinator' });
  }

  /**
   * Claims up to `limit` queued Dispatches, runs the Funding Check
   * (ADR-0024) across the whole claimed batch, then drives each remaining
   * Call through validate/prepare/sign/broadcast — grouped by chain (and so,
   * per ADR-0016's single-Sender-per-chain, by Sender too) and bundled
   * wherever the Chain Handler's own `prepare()` chooses to bundle them
   * (issue 10/ADR-0006). Bundling here is same-tick opportunistic only
   * (solana-chain-handler issue 13): only Calls this one claim already
   * gathered are ever grouped together — nothing waits across ticks hoping
   * more arrive. A `validateCall` failure only ever fails its own Call; once
   * several Calls share one real transaction, a `prepare`/`sign`/`broadcast`
   * failure fails all of them together, since they genuinely share one
   * broadcast outcome (see `processChainBatch`). Every outcome is persisted
   * either way.
   */
  async processQueuedDispatches(limit: number): Promise<void> {
    const dispatches = await this.store.claimQueued(limit);
    if (dispatches.length === 0) {
      this.logger.debug({ limit }, 'no queued dispatches to claim');
      return;
    }
    this.logger.info(
      { count: dispatches.length, dispatchIds: dispatches.map((d) => d.id) },
      'claimed queued dispatches',
    );

    const fundingFailed = await this.runFundingCheck(dispatches);

    const itemsByChain = new Map<Chain, CallRef[]>();
    for (const dispatch of dispatches) {
      for (let callIndex = 0; callIndex < dispatch.items.length; callIndex++) {
        if (fundingFailed.has(callKey(dispatch.id, callIndex))) continue;
        const group = itemsByChain.get(dispatch.chain);
        const ref = { dispatch, callIndex };
        if (group) group.push(ref);
        else itemsByChain.set(dispatch.chain, [ref]);
      }
    }

    for (const [chain, items] of itemsByChain) {
      const handler = this.requireChainHandler(chain);
      const senderAddress = this.requireSenderAddress(chain);
      await this.processChainBatch(handler, senderAddress, chain, items);
    }
  }

  /**
   * issue 13 (solana-chain-handler): validates every still-eligible Call
   * individually first — an invalid Call never rides along in a bundle with
   * valid ones — then hands every Call that passed to a single `prepare()`
   * call together, letting the Chain Handler decide how (or whether) to
   * chunk them into real transactions. `PreparedTransaction.unsignedTransaction`
   * is this interface's own opaque grouping key (ADR-0027): a Chain Handler
   * that bundles ties several Calls to byte-identical `unsignedTransaction`
   * bytes for whatever shares one real transaction, so grouping by that
   * value — without ever decoding it — is exactly how the Coordinator
   * recovers which Calls ended up sharing one broadcast.
   */
  private async processChainBatch(
    handler: ChainHandler,
    senderAddress: string,
    chain: Chain,
    items: CallRef[],
  ): Promise<void> {
    const valid: (CallRef & { call: Call })[] = [];
    for (const { dispatch, callIndex } of items) {
      const item = dispatch.items[callIndex];
      if (!item) continue;
      const log = this.logger.child({ dispatchId: dispatch.id, callIndex, chain });

      const validation = await handler.validateCall(item.call);
      if (!validation.ok) {
        log.warn({ stage: 'validateCall', error: validation.error }, 'call failed');
        await this.store.recordCallFailure({
          dispatchId: dispatch.id,
          callIndex,
          chain,
          error: validation.error,
        });
        continue;
      }
      valid.push({ dispatch, callIndex, call: item.call });
    }
    if (valid.length === 0) return;

    const prepareResult = await handler.prepare(
      valid.map((v) => v.call),
      senderAddress,
    );
    if (!prepareResult.ok) {
      this.logger.warn(
        { chain, count: valid.length, error: prepareResult.error },
        'prepare failed for a claimed batch of calls',
      );
      for (const { dispatch, callIndex } of valid) {
        await this.store.recordCallFailure({
          dispatchId: dispatch.id,
          callIndex,
          chain,
          error: prepareResult.error,
        });
      }
      return;
    }

    const chunks = new Map<UnsignedTransaction, { prepared: PreparedTransaction; members: CallRef[] }>();
    prepareResult.value.forEach((prepared, i) => {
      const source = valid[i];
      if (!source) {
        throw new Error(
          `prepare() returned a PreparedTransaction at index ${i} with no matching input Call for chain ${chain} — a ChainHandler must return exactly one PreparedTransaction per input Call, in order.`,
        );
      }
      const chunk = chunks.get(prepared.unsignedTransaction);
      if (chunk) chunk.members.push({ dispatch: source.dispatch, callIndex: source.callIndex });
      else
        chunks.set(prepared.unsignedTransaction, {
          prepared,
          members: [{ dispatch: source.dispatch, callIndex: source.callIndex }],
        });
    });

    for (const { prepared, members } of chunks.values()) {
      await this.processChunk(handler, senderAddress, chain, prepared, members);
    }
  }

  /**
   * Signs and broadcasts exactly once per real transaction — never once per
   * contributing Call — then fans the single resulting hash (or failure)
   * back out to every Call that shares it, giving each its own Transaction
   * row (CONTEXT.md: an Attempt/Transaction is about signed bytes, not
   * about which Calls happened to ride along in it).
   */
  private async processChunk(
    handler: ChainHandler,
    senderAddress: string,
    chain: Chain,
    prepared: PreparedTransaction,
    members: CallRef[],
  ): Promise<void> {
    const log = this.logger.child({ chain, bundleSize: members.length });

    const signResult = await handler.sign(prepared, senderAddress);
    if (!signResult.ok) {
      log.warn({ stage: 'sign', error: signResult.error }, 'call(s) failed');
      for (const { dispatch, callIndex } of members) {
        await this.store.recordCallFailure({
          dispatchId: dispatch.id,
          callIndex,
          chain,
          error: signResult.error,
        });
      }
      return;
    }

    const broadcastResult = await handler.broadcast(signResult.value);
    if (!broadcastResult.ok) {
      log.warn({ stage: 'broadcast', error: broadcastResult.error }, 'call(s) failed');
      for (const { dispatch, callIndex } of members) {
        await this.store.recordCallFailure({
          dispatchId: dispatch.id,
          callIndex,
          chain,
          error: broadcastResult.error,
        });
      }
      return;
    }

    log.info({ hash: broadcastResult.value.hash }, 'call(s) broadcast succeeded');
    for (const { dispatch, callIndex } of members) {
      await this.store.createTransaction({
        dispatchId: dispatch.id,
        callIndex,
        chain,
        signedBytes: signResult.value,
        hash: broadcastResult.value.hash,
      });
    }
  }

  /**
   * Aggregates the required amount per (chain, asset) across the whole
   * claimed batch — from each item's original Payment (ADR-0028's
   * DispatchItem), never by trying to decode an opaque Call — and compares
   * it against the Sender's real balance via getBalance, before any of
   * those Calls are prepared/signed/broadcast (ADR-0024). A `call`-type
   * item (no Payment) has no inferable funding requirement and is skipped
   * entirely: the caller owns that data, not the engine (ADR-0018).
   *
   * A shortfall — or a getBalance failure itself, since an unverifiable
   * balance is exactly the "discover it one Call at a time" outcome this
   * check exists to prevent — fails every affected Call immediately via
   * recordCallFailure. Returns which (dispatchId, callIndex) pairs were
   * failed this way, so the caller skips them in the main processing loop.
   */
  private async runFundingCheck(dispatches: Dispatch[]): Promise<Set<string>> {
    const failedKeys = new Set<string>();
    const requirements = new Map<string, FundingRequirement>();

    for (const dispatch of dispatches) {
      dispatch.items.forEach((item, callIndex) => {
        if (!item.payment) return;
        const { asset, amount } = item.payment;
        // A control character, not a real asset symbol, so an asset name can never collide with the delimiter.
        const key = `${dispatch.chain}\u0000${asset}`;
        const existing = requirements.get(key);
        if (existing) {
          existing.required += BigInt(amount);
          existing.items.push({ dispatch, callIndex });
        } else {
          requirements.set(key, {
            chain: dispatch.chain,
            asset,
            required: BigInt(amount),
            items: [{ dispatch, callIndex }],
          });
        }
      });
    }

    for (const { chain, asset, required, items } of requirements.values()) {
      const handler = this.requireChainHandler(chain);
      const senderAddress = this.requireSenderAddress(chain);

      const balanceResult = await handler.getBalance(senderAddress, asset);
      if (!balanceResult.ok) {
        this.logger.warn(
          { chain, asset, error: balanceResult.error },
          'funding check: getBalance failed, failing affected calls',
        );
        await this.failFundingItems(items, balanceResult.error, failedKeys);
        continue;
      }

      const available = BigInt(balanceResult.value.amount);
      if (available < required) {
        const short = (required - available).toString();
        this.logger.warn(
          { chain, asset, required: required.toString(), available: available.toString(), short },
          'funding check: insufficient balance, failing affected calls',
        );
        await this.failFundingItems(
          items,
          {
            code: 'INSUFFICIENT_FUNDS',
            message: `insufficient ${asset} balance`,
            chainDetail: { asset, short },
          },
          failedKeys,
        );
      }
    }

    return failedKeys;
  }

  /** Records the same failure reason for every (dispatch, callIndex) a Funding Check requirement covers, and marks each skipped in the caller's main processing loop. */
  private async failFundingItems(
    items: CallRef[],
    error: DispatchError,
    failedKeys: Set<string>,
  ): Promise<void> {
    for (const { dispatch, callIndex } of items) {
      await this.store.recordCallFailure({
        dispatchId: dispatch.id,
        callIndex,
        chain: dispatch.chain,
        error,
      });
      failedKeys.add(callKey(dispatch.id, callIndex));
    }
  }

  /**
   * relay-dispatch issue 01: claims up to `limit` queued RelayDispatches and
   * broadcasts each one's already-signed bytes exactly once — no
   * validateCall/prepare/sign step, nothing to build or sign, it already
   * arrived signed (ADR-0005/ADR-0031). No Funding Check either (nothing
   * here is the engine's own money) and no senderAddress (broadcast doesn't
   * need one). `pollPendingTransactions` below then tracks the resulting
   * Transaction to a terminal state exactly like a Managed Dispatch one.
   */
  async processQueuedRelayDispatches(limit: number): Promise<void> {
    const relayDispatches = await this.store.claimQueuedRelayDispatches(limit);
    if (relayDispatches.length === 0) {
      this.logger.debug({ limit }, 'no queued relay dispatches to claim');
      return;
    }
    this.logger.info(
      { count: relayDispatches.length, relayDispatchIds: relayDispatches.map((r) => r.id) },
      'claimed queued relay dispatches',
    );

    for (const relayDispatch of relayDispatches) {
      await this.processRelayDispatch(relayDispatch);
    }
  }

  private async processRelayDispatch(relayDispatch: RelayDispatch): Promise<void> {
    const handler = this.requireChainHandler(relayDispatch.chain);
    const log = this.logger.child({
      relayDispatchId: relayDispatch.id,
      chain: relayDispatch.chain,
    });

    let broadcastResult: Awaited<ReturnType<ChainHandler['broadcast']>> | undefined;
    for (let attempt = 0; attempt < RELAY_BROADCAST_MAX_ATTEMPTS; attempt++) {
      log.debug({ attempt }, 'broadcasting relay dispatch');
      broadcastResult = await handler.broadcast(relayDispatch.signedTransaction);
      if (broadcastResult.ok) break;
      if (
        attempt === RELAY_BROADCAST_MAX_ATTEMPTS - 1 ||
        !isTransientBroadcastFailure(broadcastResult.error)
      ) {
        break;
      }
      log.warn(
        { attempt, error: broadcastResult.error },
        'transient relay dispatch broadcast failure, retrying with identical bytes',
      );
      await this.sleep(RELAY_BROADCAST_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }

    // A single item, always at callIndex 0 (RelayDispatch is never a batch,
    // ADR-0031) — createTransaction/recordCallFailure are the exact same
    // DispatchStore methods Managed Dispatch's processCall already uses, so
    // Transaction/Attempt records are reused completely unchanged.
    let transaction;
    if (broadcastResult?.ok === true) {
      log.info({ hash: broadcastResult.value.hash }, 'relay dispatch broadcast succeeded');
      transaction = await this.store.createTransaction({
        dispatchId: relayDispatch.id,
        callIndex: 0,
        chain: relayDispatch.chain,
        signedBytes: relayDispatch.signedTransaction,
        hash: broadcastResult.value.hash,
      });
    } else {
      const error = broadcastResult?.error ?? {
        code: 'RPC_UNAVAILABLE' as const,
        message: 'broadcast was never attempted',
      };
      log.warn({ error }, 'relay dispatch broadcast failed');
      transaction = await this.store.recordCallFailure({
        dispatchId: relayDispatch.id,
        callIndex: 0,
        chain: relayDispatch.chain,
        error,
      });
    }

    await this.store.setRelayDispatchTransaction(relayDispatch.id, transaction.id);
  }

  /**
   * Advances up to `limit` still-PENDING Transactions: checks on-chain
   * status via the Chain Handler, and — with Retry Policy off — marks one
   * ABANDONED once it's been PENDING longer than its chain's timeout. That
   * timeout applies even when the status check itself fails (e.g. RPC
   * unavailable) — elapsed time is all ADR-0004 measures, so a chain having
   * connectivity trouble must not silently suppress abandonment forever.
   * Retry Policy on suppresses abandonment entirely; this scaffold doesn't
   * implement an actual fee-bump retry (no real Chain Handler exists yet
   * to bump), just the opt-out from the default safety net.
   */
  async pollPendingTransactions(limit: number): Promise<void> {
    const pending = await this.store.listPendingTransactions(limit);
    this.logger.debug({ count: pending.length, limit }, 'polling pending transactions');

    for (const transaction of pending) {
      await this.resolvePendingTransaction(transaction);
    }
  }

  /**
   * issue 10 (ADR-0004/CONTEXT.md): "the engine keeps a low-frequency
   * background check running for [an ABANDONED transaction], for a
   * bounded window, and reports if it does [confirm]." Deliberately a
   * separate method from pollPendingTransactions, not a second branch
   * inside it — the whole point is a genuinely different (much slower)
   * cadence, which the caller controls simply by calling this less often,
   * not by any state this method itself has to track. A transaction
   * whose abandonedAt has aged out of the bounded window is silently
   * excluded by the store query below and never looked at again — that's
   * not a bug, it's "stopped watching" finally meaning it.
   */
  async rewatchAbandonedTransactions(limit: number): Promise<void> {
    const notAbandonedBefore = new Date(this.now().getTime() - this.abandonedRewatchWindowMs);
    const abandoned = await this.store.listAbandonedTransactions(limit, notAbandonedBefore);
    this.logger.debug({ count: abandoned.length, limit }, 'rewatching abandoned transactions');

    for (const transaction of abandoned) {
      await this.resolveAbandonedTransaction(transaction);
    }
  }

  /**
   * base-chain-handler issue 07: a pure background safety net for a chain
   * (today, only 'base') whose `getStatus` reports CONFIRMED before real
   * finality, trading speed for a small reorg window — never gates or
   * delays the initial CONFIRMED report itself (a wholly separate method,
   * never called from processChainBatch/resolvePendingTransaction). Chains
   * absent from `reorgRecheckWindowMs` (e.g. 'solana', whose own commitment
   * levels already cover this) are never touched by this loop at all. A
   * Transaction whose `confirmedAt` has aged past its own chain's window is
   * silently excluded from `listRecentlyConfirmedTransactions` below and
   * never looked at again — same "stopped watching, finally meaning it"
   * discipline as `rewatchAbandonedTransactions`.
   */
  async recheckRecentlyConfirmedTransactions(limit: number): Promise<void> {
    for (const [chain, windowMs] of this.reorgRecheckWindowMs) {
      const notConfirmedBefore = new Date(this.now().getTime() - windowMs);
      const confirmed = await this.store.listRecentlyConfirmedTransactions(chain, limit, notConfirmedBefore);
      this.logger.debug({ chain, count: confirmed.length, limit }, 'rechecking recently confirmed transactions');

      for (const transaction of confirmed) {
        await this.recheckConfirmedTransaction(transaction);
      }
    }
  }

  /**
   * Re-asks `getStatus` for a hash already persisted as CONFIRMED — the
   * exact same call `tryResolveByStatus` makes for a PENDING one, just
   * aimed at a different starting state. Still CONFIRMED: nothing to do,
   * it'll simply age out of the window above eventually. Now FAILED: a
   * genuine, if rare, possibility after a reorg re-orders execution: marks
   * it failed for real. No longer found at all (`getStatus` reports
   * PENDING again): the receipt is gone — reopens it back to PENDING so it
   * re-enters the normal poll/abandonment lifecycle rather than being left
   * silently, permanently wrong. A `getStatus` failure (e.g. RPC hiccup)
   * is not evidence of a reorg and leaves the Transaction untouched — the
   * next cadence tries again.
   */
  private async recheckConfirmedTransaction(transaction: Transaction): Promise<void> {
    if (!transaction.hash) {
      throw new Error(`Transaction ${transaction.id} is CONFIRMED but has no hash.`);
    }
    const log = this.transactionLogger(transaction).child({ reorgRecheck: true });
    const handler = this.requireChainHandler(transaction.chain);
    const statusResult = await handler.getStatus(transaction.hash);

    if (!statusResult.ok) {
      log.warn({ error: statusResult.error }, 'reorg recheck: status check failed, leaving as-is');
      return;
    }
    if (statusResult.value === 'CONFIRMED') {
      log.debug('reorg recheck: still confirmed');
      return;
    }
    if (statusResult.value === 'FAILED') {
      log.warn('reorg recheck: now reports failed after a reorg — marking failed');
      await this.store.markFailed(transaction.id, {
        code: 'CHAIN_REJECTED',
        message: `${transaction.chain} reported this transaction as failed on reorg re-check`,
      });
      return;
    }

    // statusResult.value === 'PENDING': the receipt this handler once
    // reported is no longer found — a reorg dropped it.
    log.warn('reorg recheck: receipt no longer found — reopening');
    await this.store.reopenTransaction(transaction.id);
  }

  private async resolvePendingTransaction(transaction: Transaction): Promise<void> {
    const log = this.transactionLogger(transaction);
    const resolved = await this.tryResolveByStatus(transaction, log);
    if (resolved) return;

    // Either still PENDING on-chain, or the status check itself failed (e.g.
    // RPC unavailable) — either way, fall through to the ABANDONED timeout.
    // That timeout is a pure elapsed-time decision (ADR-0004: "the engine
    // stopped watching without a definitive outcome"), so it must not be
    // gated behind a successful status check — a chain having connectivity
    // trouble is exactly a case where the engine should eventually stop
    // watching, not one where the timeout silently never fires.
    await this.maybeAbandon(transaction, log);
  }

  /**
   * issue 10: the exact same CONFIRMED/FAILED resolution a still-PENDING
   * Transaction gets, applied identically to an already-ABANDONED one
   * being re-watched — "reports if it does [confirm]" (CONTEXT.md) means
   * exactly this: update the Transaction's own status, so the next poll
   * of GET /v1/dispatch/:id tells the truth. No new event/webhook concept
   * needed (ADR-0023 defers those anyway); polling is already how every
   * other status change gets reported. If it's neither, it simply stays
   * ABANDONED — never re-abandoned, never re-timed-out — until either the
   * next low-frequency check resolves it or the bounded window excludes
   * it from being checked at all.
   */
  private async resolveAbandonedTransaction(transaction: Transaction): Promise<void> {
    const log = this.transactionLogger(transaction).child({ rewatch: true });
    const resolved = await this.tryResolveByStatus(transaction, log);
    if (resolved) {
      log.info('previously-ABANDONED transaction resolved after all');
    }
  }

  private transactionLogger(transaction: Transaction): Logger {
    return this.logger.child({
      transactionId: transaction.id,
      hash: transaction.hash,
      chain: transaction.chain,
    });
  }

  /**
   * Shared by resolvePendingTransaction and resolveAbandonedTransaction:
   * checks on-chain status and, if it's now definitive, persists it and
   * returns true. Returns false for anything still unresolved (genuinely
   * PENDING on-chain, or the status check itself failed) — each caller
   * decides what "still unresolved" means for its own transaction (start
   * the ABANDONED clock; or, for one already ABANDONED, nothing at all).
   */
  private async tryResolveByStatus(transaction: Transaction, log: Logger): Promise<boolean> {
    if (!transaction.hash) {
      throw new Error(
        `Transaction ${transaction.id} has no hash — only a broadcast Transaction should ever reach status resolution.`,
      );
    }

    const handler = this.requireChainHandler(transaction.chain);
    const statusResult = await handler.getStatus(transaction.hash);

    if (statusResult.ok && statusResult.value === 'CONFIRMED') {
      log.info('transaction confirmed');
      await this.store.markConfirmed(transaction.id);
      return true;
    }

    if (statusResult.ok && statusResult.value === 'FAILED') {
      log.info('transaction failed');
      await this.store.markFailed(transaction.id, {
        code: 'CHAIN_REJECTED',
        message: `${transaction.chain} reported this transaction as failed`,
      });
      return true;
    }

    if (!statusResult.ok) {
      log.warn({ error: statusResult.error }, 'getStatus failed, still unresolved');
    } else {
      log.debug('transaction still pending on-chain');
    }
    return false;
  }

  private async maybeAbandon(transaction: Transaction, log: Logger): Promise<void> {
    const dispatch = await this.store.getDispatch(transaction.dispatchId);
    if (dispatch) {
      if (dispatch.retryPolicy) return; // opted in: never auto-abandon (ADR-0003)
    } else {
      // relay-dispatch issue 01: a RelayDispatch's Transaction.dispatchId
      // points at its own (non-Dispatch) row, so getDispatch legitimately
      // finds nothing for it — confirm that's actually why before treating
      // the miss as harmless, so a genuinely orphaned Managed Dispatch
      // Transaction (a real data-integrity bug) still throws loudly instead
      // of silently degrading into "abandon on timeout." RelayDispatch has
      // no retryPolicy concept at all (nothing for the engine to fee-bump,
      // ADR-0031), which is exactly the same as `retryPolicy: false` here:
      // never suppress the default ABANDONED-after-timeout path.
      const relayDispatch = await this.store.getRelayDispatch(transaction.dispatchId);
      if (!relayDispatch) {
        throw new Error(
          `Transaction ${transaction.id} references unknown Dispatch ${transaction.dispatchId}.`,
        );
      }
    }

    if (!transaction.broadcastAt) {
      throw new Error(
        `Transaction ${transaction.id} is PENDING but has no broadcastAt — only a broadcast Transaction should ever be PENDING.`,
      );
    }

    const timeoutMs = this.abandonmentTimeoutMs.get(transaction.chain);
    if (timeoutMs === undefined) {
      throw new Error(`No ABANDONED timeout configured for chain: ${transaction.chain}`);
    }

    const elapsedMs = this.now().getTime() - transaction.broadcastAt.getTime();
    if (elapsedMs >= timeoutMs) {
      log.warn(
        { elapsedMs, timeoutMs },
        'transaction abandoned: no definitive outcome within its chain-aware timeout',
      );
      await this.store.markAbandoned(transaction.id);
    }
  }

  private requireChainHandler(chain: Chain): ChainHandler {
    const handler = this.chainHandlers.get(chain);
    if (!handler) {
      throw new Error(
        `No ChainHandler registered for chain: ${chain} — the chain registry (issue 07) should never let a Dispatch for an unenabled chain reach the Coordinator.`,
      );
    }
    return handler;
  }

  private requireSenderAddress(chain: Chain): string {
    const senderAddress = this.senderAddresses.get(chain);
    if (!senderAddress) {
      throw new Error(`No Sender address configured for chain: ${chain}`);
    }
    return senderAddress;
  }
}

function callKey(dispatchId: string, callIndex: number): string {
  return `${dispatchId}:${callIndex}`;
}
