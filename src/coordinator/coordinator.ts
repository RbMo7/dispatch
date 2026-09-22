import type { ChainHandler } from '../chain-handler/chain-handler.js';
import type { Chain } from '../domain/chain.js';
import type { Dispatch } from '../domain/dispatch.js';
import type { Transaction } from '../domain/transaction.js';
import type { DispatchStore } from '../repository/dispatch-store.js';

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

  constructor(deps: CoordinatorDeps) {
    this.store = deps.store;
    this.chainHandlers = deps.chainHandlers;
    this.senderAddresses = deps.senderAddresses;
    this.abandonmentTimeoutMs = deps.abandonmentTimeoutMs;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Claims up to `limit` queued Dispatches and drives each Call through
   * validate/prepare/sign/broadcast independently — one Call's failure
   * never blocks another's (the default batching mode is one transaction
   * per payment, ADR-0006). Every outcome is persisted either way.
   */
  async processQueuedDispatches(limit: number): Promise<void> {
    const dispatches = await this.store.claimQueued(limit);

    for (const dispatch of dispatches) {
      const handler = this.requireChainHandler(dispatch.chain);
      const senderAddress = this.requireSenderAddress(dispatch.chain);

      for (let callIndex = 0; callIndex < dispatch.items.length; callIndex++) {
        await this.processCall(dispatch, handler, senderAddress, callIndex);
      }
    }
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
    const call = dispatch.items[callIndex];
    if (call === undefined) return;

    const validation = await handler.validateCall(call);
    if (!validation.ok) {
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
      await this.store.recordCallFailure({
        dispatchId: dispatch.id,
        callIndex,
        chain: dispatch.chain,
        error: broadcastResult.error,
      });
      return;
    }

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

    const handler = this.requireChainHandler(transaction.chain);
    const statusResult = await handler.getStatus(transaction.hash);

    if (statusResult.ok && statusResult.value === 'CONFIRMED') {
      await this.store.markConfirmed(transaction.id);
      return;
    }

    if (statusResult.ok && statusResult.value === 'FAILED') {
      await this.store.markFailed(transaction.id, {
        code: 'CHAIN_REJECTED',
        message: `${transaction.chain} reported this transaction as failed`,
      });
      return;
    }

    // Either still PENDING on-chain, or the status check itself failed (e.g.
    // RPC unavailable) — either way, fall through to the ABANDONED timeout.
    // That timeout is a pure elapsed-time decision (ADR-0004: "the engine
    // stopped watching without a definitive outcome"), so it must not be
    // gated behind a successful status check — a chain having connectivity
    // trouble is exactly a case where the engine should eventually stop
    // watching, not one where the timeout silently never fires.
    await this.maybeAbandon(transaction);
  }

  private async maybeAbandon(transaction: Transaction): Promise<void> {
    const dispatch = await this.store.getDispatch(transaction.dispatchId);
    if (!dispatch) {
      throw new Error(
        `Transaction ${transaction.id} references unknown Dispatch ${transaction.dispatchId}.`,
      );
    }
    if (dispatch.retryPolicy) return; // opted in: never auto-abandon (ADR-0003)

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
