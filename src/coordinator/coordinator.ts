import type { Logger } from 'pino';

import type { ChainHandler } from '../chain-handler/chain-handler.js';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only a send-layer hiccup is worth retrying with identical bytes — a genuine on-chain rejection (CHAIN_REJECTED) never becomes true by resending the exact same bytes again. */
function isTransientBroadcastFailure(error: DispatchError): boolean {
  return error.code === 'RPC_UNAVAILABLE';
}

type FundingRequirement = {
  chain: Chain;
  asset: string;
  required: bigint;
  items: { dispatch: Dispatch; callIndex: number }[];
};

export type CoordinatorDeps = {
  store: DispatchStore;
  /** Populated by the chain registry (issue 07, `ChainRegistry.handlers`) — a claimed Dispatch naming an unregistered chain is a configuration bug, never a business-relevant outcome, so it's not surfaced as a DispatchError here. */
  chainHandlers: ReadonlyMap<Chain, ChainHandler>;
  /** Deployment config, one Sender wallet per chain (ADR-0016: Sender Pool is deferred — single-Sender ships first). */
  senderAddresses: Map<Chain, string>;
  /** The chain-aware ABANDONED timeout (ADR-0004) — how long a still-PENDING transaction may wait, with Retry Policy off, before the Coordinator stops watching it. */
  abandonmentTimeoutMs: Map<Chain, number>;
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
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;

  constructor(deps: CoordinatorDeps) {
    this.store = deps.store;
    this.chainHandlers = deps.chainHandlers;
    this.senderAddresses = deps.senderAddresses;
    this.abandonmentTimeoutMs = deps.abandonmentTimeoutMs;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? sleep;
    this.logger = (deps.logger ?? defaultLogger).child({ component: 'coordinator' });
  }

  /**
   * Claims up to `limit` queued Dispatches, runs the Funding Check
   * (ADR-0024) across the whole claimed batch, then drives each remaining
   * Call through validate/prepare/sign/broadcast independently — one Call's
   * failure never blocks another's (the default batching mode is one
   * transaction per payment, ADR-0006). Every outcome is persisted either
   * way.
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

    for (const dispatch of dispatches) {
      const handler = this.requireChainHandler(dispatch.chain);
      const senderAddress = this.requireSenderAddress(dispatch.chain);

      for (let callIndex = 0; callIndex < dispatch.items.length; callIndex++) {
        if (fundingFailed.has(callKey(dispatch.id, callIndex))) continue;
        await this.processCall(dispatch, handler, senderAddress, callIndex);
      }
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
    items: { dispatch: Dispatch; callIndex: number }[],
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

  private async processCall(
    dispatch: Dispatch,
    handler: ChainHandler,
    senderAddress: string,
    callIndex: number,
  ): Promise<void> {
    const item = dispatch.items[callIndex];
    if (item === undefined) return;
    const call = item.call;
    const log = this.logger.child({ dispatchId: dispatch.id, callIndex, chain: dispatch.chain });

    const validation = await handler.validateCall(call);
    if (!validation.ok) {
      log.warn({ stage: 'validateCall', error: validation.error }, 'call failed');
      await this.store.recordCallFailure({
        dispatchId: dispatch.id,
        callIndex,
        chain: dispatch.chain,
        error: validation.error,
      });
      return;
    }

    const prepareResult = await handler.prepare([call], senderAddress);
    if (!prepareResult.ok) {
      log.warn({ stage: 'prepare', error: prepareResult.error }, 'call failed');
      await this.store.recordCallFailure({
        dispatchId: dispatch.id,
        callIndex,
        chain: dispatch.chain,
        error: prepareResult.error,
      });
      return;
    }

    const prepared = prepareResult.value[0];
    if (!prepared) {
      throw new Error(
        `prepare() returned no PreparedTransaction for callIndex ${callIndex} of dispatch ${dispatch.id} — a ChainHandler must return one PreparedTransaction per input Call.`,
      );
    }

    const signResult = await handler.sign(prepared, senderAddress);
    if (!signResult.ok) {
      log.warn({ stage: 'sign', error: signResult.error }, 'call failed');
      await this.store.recordCallFailure({
        dispatchId: dispatch.id,
        callIndex,
        chain: dispatch.chain,
        error: signResult.error,
      });
      return;
    }

    const broadcastResult = await handler.broadcast(signResult.value);
    if (!broadcastResult.ok) {
      log.warn({ stage: 'broadcast', error: broadcastResult.error }, 'call failed');
      await this.store.recordCallFailure({
        dispatchId: dispatch.id,
        callIndex,
        chain: dispatch.chain,
        error: broadcastResult.error,
      });
      return;
    }

    log.info({ hash: broadcastResult.value.hash }, 'call broadcast succeeded');
    await this.store.createTransaction({
      dispatchId: dispatch.id,
      callIndex,
      chain: dispatch.chain,
      signedBytes: signResult.value,
      hash: broadcastResult.value.hash,
    });
  }

  private async resolvePendingTransaction(transaction: Transaction): Promise<void> {
    if (!transaction.hash) {
      throw new Error(
        `Transaction ${transaction.id} is PENDING but has no hash — only a broadcast Transaction should ever be PENDING.`,
      );
    }
    const log = this.logger.child({
      transactionId: transaction.id,
      hash: transaction.hash,
      chain: transaction.chain,
    });

    const handler = this.requireChainHandler(transaction.chain);
    const statusResult = await handler.getStatus(transaction.hash);

    if (statusResult.ok && statusResult.value === 'CONFIRMED') {
      log.info('transaction confirmed');
      await this.store.markConfirmed(transaction.id);
      return;
    }

    if (statusResult.ok && statusResult.value === 'FAILED') {
      log.info('transaction failed');
      await this.store.markFailed(transaction.id, {
        code: 'CHAIN_REJECTED',
        message: `${transaction.chain} reported this transaction as failed`,
      });
      return;
    }

    if (!statusResult.ok) {
      log.warn({ error: statusResult.error }, 'getStatus failed, still pending');
    } else {
      log.debug('transaction still pending');
    }

    // Either still PENDING on-chain, or the status check itself failed (e.g.
    // RPC unavailable) — either way, fall through to the ABANDONED timeout.
    // That timeout is a pure elapsed-time decision (ADR-0004: "the engine
    // stopped watching without a definitive outcome"), so it must not be
    // gated behind a successful status check — a chain having connectivity
    // trouble is exactly a case where the engine should eventually stop
    // watching, not one where the timeout silently never fires.
    await this.maybeAbandon(transaction, log);
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
