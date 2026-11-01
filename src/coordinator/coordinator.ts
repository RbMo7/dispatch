import type { Logger } from 'pino';

import type {
  BundleSlotStatus,
  ChainHandler,
  PreparedTransaction,
  UnsignedTransaction,
} from '../chain-handler/chain-handler.js';
import type { Call } from '../domain/call.js';
import { CHAINS, type Chain } from '../domain/chain.js';
import type { Dispatch } from '../domain/dispatch.js';
import type { DispatchError, DispatchErrorCode } from '../domain/errors.js';
import type { RelayDispatch } from '../domain/relay-dispatch.js';
import { err, ok, type Result } from '../domain/result.js';
import type { Transaction } from '../domain/transaction.js';
import { logger as defaultLogger } from '../logger.js';
import type { AssetAmount } from '../domain/proposal.js';
import { senderKey, type SenderAddress, type SenderRef } from '../domain/sender.js';
import type { CommittedHolder, DispatchStore } from '../repository/dispatch-store.js';
import { ApprovalFlow, DEFAULT_APPROVAL_REWATCH_WINDOW_MS } from './approval-flow.js';
import type { CoordinatorSender } from './coordinator-sender.js';

export type { CoordinatorSender } from './coordinator-sender.js';

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

/** ADR-0042: how many times a Call whose transaction provably expired is resubmitted before it is reported FAILED. */
const MAX_EXPIRY_RESUBMISSIONS = 3;

/**
 * Fee-bump failures that end bumping for good: the Call's attempts go to
 * the cap and the original stays tracked, rebroadcast and abandoned as with
 * Retry Policy off. Every other failure counts one attempt and is retried.
 */
const BUMPING_STOPS_ON: Partial<Record<DispatchErrorCode, string>> = {
  /** #9 (ADR-0037): some version already landed. */
  NONCE_ALREADY_USED: 'nonce already used on-chain — some version landed',
  /** ADR-0046: the Signer refused the replacement on purpose; the original may still land. */
  SIGNER_REFUSED: 'the Signer refused the replacement',
};

/** #20 (ADR-0041): how long a claim may stay `broadcasting` with unsent items before another tick resumes it. */
const STALE_CLAIM_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * #20 (ADR-0041): the send may have reached the node — or it's already
 * pooled — so the Transaction stays PENDING for polling and rebroadcast to
 * resolve. Never a FAILED.
 */
function isAmbiguousBroadcastFailure(error: DispatchError): boolean {
  return error.code === 'RPC_UNAVAILABLE' || error.code === 'ALREADY_KNOWN';
}

/** Only a send-layer hiccup is worth retrying with identical bytes — a genuine on-chain rejection (CHAIN_REJECTED) never becomes true by resending the exact same bytes again. */
function isTransientBroadcastFailure(error: DispatchError): boolean {
  return error.code === 'RPC_UNAVAILABLE';
}

/** A (Dispatch, callIndex) pointer to one Call — the Funding Check's own grouping unit, and issue 13's bundling grouping unit. */
type CallRef = { dispatch: Dispatch; callIndex: number };

type FundingRequirement = {
  /** Who holds the funds, when not the Sender (#11). */
  fundedBy: string | null;
  asset: string;
  required: bigint;
  items: CallRef[];
  /** ADR-0054, a Multisig Sender only: which of its two balances this requirement is paid from. */
  holder?: CommittedHolder;
};

export type StuckHandlingConfig = { stuckAfterMs: number; maxFeeBumps: number };

export type CoordinatorDeps = {
  store: DispatchStore;
  /**
   * Populated by the chain registry (issue 07, `ChainRegistry.handlers`). Its
   * keys are the enabled chains: the Coordinator only ever loads work for these
   * (#57). Each is also the handler for work that belongs to no configured
   * Sender: a Relay Dispatch, or a Sender removed from the configuration.
   */
  chainHandlers: ReadonlyMap<Chain, ChainHandler>;
  /** ADR-0060: every Sender the engine executes for, each with its own handler. Takes precedence over `senderAddresses`. */
  senders?: readonly CoordinatorSender[];
  /** The single-Sender shape: one Sender per chain, paying from this address with that chain's `chainHandlers` handler. */
  senderAddresses?: Map<Chain, string>;
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
  /**
   * #9 (ADR-0037): the chains that opt into stuck-transaction handling, and
   * how. A transaction still PENDING `stuckAfterMs` after its latest
   * broadcast is fee-bumped (Managed Dispatch, Retry Policy on, a handler
   * with `prepareReplacement`, fewer than `maxFeeBumps` attempts so far) or
   * otherwise rebroadcast as identical bytes. A chain absent here (e.g.
   * 'solana') is never touched. Defaults to an empty map.
   */
  stuckHandling?: Map<Chain, StuckHandlingConfig>;
  /** ADR-0054/0053: how long a Multisig Sender's Proposal waits for approval before its Calls are abandoned. Defaults to 72 hours; only read for a chain whose handler has an `approval` capability. */
  approvalDeadlineMs?: number;
  /** ADR-0053: how long a timed-out Proposal still counts as committed in the Funding Check (the watch window). Defaults to 30 days; only read for a chain whose handler has an `approval` capability. */
  approvalRewatchWindowMs?: number;
  /** Per-chain override of `approvalRewatchWindowMs` for the single-Sender shape (`SOLANA_…` / `BASE_APPROVAL_REWATCH_WINDOW_MS`). */
  approvalRewatchWindowMsByChain?: Map<Chain, number>;
  /** Per-chain override of `approvalDeadlineMs` for the single-Sender shape (`SOLANA_…` / `BASE_APPROVAL_DEADLINE_MS`). */
  approvalDeadlineMsByChain?: Map<Chain, number>;
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
  private readonly enabledChains: Chain[];
  /** ADR-0060: the units of execution. */
  readonly senders: readonly CoordinatorSender[];
  private readonly senderByKey: ReadonlyMap<string, CoordinatorSender>;
  private readonly defaultSenders: ReadonlyMap<Chain, CoordinatorSender>;
  private readonly abandonmentTimeoutMs: Map<Chain, number>;
  private readonly abandonedRewatchWindowMs: number;
  private readonly approvalRewatchWindowMs: number;
  private readonly reorgRecheckWindowMs: Map<Chain, number>;
  private readonly stuckHandling: Map<Chain, StuckHandlingConfig>;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;
  /** ADR-0054: the chain-neutral multisig state machine; only ever touched for a chain whose handler has `.approval`. */
  private readonly approvalFlow: ApprovalFlow;
  /** #20 review: Dispatches this Coordinator is processing right now — never reclaimed out from under itself. */
  private readonly inFlight = new Set<string>();
  /** #11: one bundle trace per hash per poll tick — cleared at the start of every tick. */
  private bundleStatusCache = new Map<string, Promise<Result<BundleSlotStatus[], DispatchError>>>();

  constructor(deps: CoordinatorDeps) {
    this.store = deps.store;
    this.chainHandlers = deps.chainHandlers;
    this.enabledChains = [...deps.chainHandlers.keys()];
    this.senders = (deps.senders ?? singleSenders(deps)).filter((sender) =>
      deps.chainHandlers.has(sender.ref.chain),
    );
    this.senderByKey = new Map(this.senders.map((sender) => [senderKey(sender.ref), sender]));
    this.defaultSenders = new Map(
      this.senders.filter((sender) => sender.isDefault).map((sender) => [sender.ref.chain, sender]),
    );
    this.abandonmentTimeoutMs = deps.abandonmentTimeoutMs;
    this.abandonedRewatchWindowMs =
      deps.abandonedRewatchWindowMs ?? DEFAULT_ABANDONED_REWATCH_WINDOW_MS;
    this.approvalRewatchWindowMs =
      deps.approvalRewatchWindowMs ?? DEFAULT_APPROVAL_REWATCH_WINDOW_MS;
    this.reorgRecheckWindowMs = deps.reorgRecheckWindowMs ?? new Map<Chain, number>();
    this.stuckHandling = deps.stuckHandling ?? new Map<Chain, StuckHandlingConfig>();
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? sleep;
    this.logger = (deps.logger ?? defaultLogger).child({ component: 'coordinator' });
    this.approvalFlow = new ApprovalFlow({
      store: this.store,
      senders: this.senders,
      now: this.now,
      logger: this.logger,
      approvalDeadlineMs: deps.approvalDeadlineMs,
      approvalRewatchWindowMs: this.approvalRewatchWindowMs,
    });
  }

  /**
   * Claims up to `limit` queued Dispatches per Sender, every Sender at once
   * (ADR-0060), and processes each Sender's claim on its own: see
   * `processQueuedDispatchesFor`. The worker runs one loop per Sender
   * instead, so a slow Sender never delays the next claim of another.
   */
  async processQueuedDispatches(limit: number): Promise<void> {
    await Promise.all(
      this.senders.map((sender) => this.processQueuedDispatchesFor(sender.ref, limit)),
    );
  }

  /**
   * Claims up to `limit` of `ref`'s queued Dispatches, runs the Funding Check
   * (ADR-0024) across the whole claimed batch, then drives each remaining
   * Call through validate/prepare/sign/broadcast — all of one Sender
   * (ADR-0060), so a bundle never mixes Senders — bundled wherever the Chain
   * Handler's own `prepare()` chooses to bundle them (issue 10/ADR-0006).
   * Bundling here is same-tick opportunistic only (solana-chain-handler
   * issue 13): only Calls this one claim already gathered are ever grouped
   * together — nothing waits across ticks hoping more arrive. A
   * `validateCall` failure only ever fails its own Call; once several Calls
   * share one real transaction, a `prepare`/`sign`/`broadcast` failure fails
   * all of them together, since they genuinely share one broadcast outcome
   * (see `processSenderBatch`). Every outcome is persisted either way.
   */
  async processQueuedDispatchesFor(ref: SenderRef, limit: number): Promise<void> {
    const sender = this.requireSender(ref);
    // ADR-0060: a Dispatch stored with no Sender is the default Sender's before anyone claims it.
    if (sender.isDefault) await this.store.assignUnassignedDispatches(sender.ref);
    const dispatches = await this.store.claimQueuedFor(sender.ref, limit);
    if (dispatches.length === 0) {
      this.logger.debug({ limit, sender: ref.address }, 'no queued dispatches to claim');
    } else {
      this.logger.info(
        {
          count: dispatches.length,
          chain: ref.chain,
          sender: ref.address,
          dispatchIds: dispatches.map((d) => d.id),
        },
        'claimed queued dispatches',
      );
      for (const dispatch of dispatches) this.inFlight.add(dispatch.id);
      try {
        await this.processClaimedDispatches(sender, dispatches);
      } finally {
        for (const dispatch of dispatches) this.inFlight.delete(dispatch.id);
      }
    }
    // ADR-0054: Calls left UNPROPOSED (a full slot, an unreachable Signer) are retried every tick.
    await this.approvalFlow.proposeUnproposed(sender);
  }

  /**
   * ADR-0054: watches up to `limit` Proposals whose next check is due —
   * executing the approved, failing the rejected, abandoning the undecided
   * (ADR-0053). Touches nothing for a chain without an approval capability.
   */
  async watchProposals(limit: number): Promise<void> {
    await this.approvalFlow.watch(limit);
  }

  /**
   * ADR-0060: gives every Dispatch stored with no Sender (from before named
   * Senders) to its chain's default Sender. Idempotent; the worker runs it
   * once at startup, before anything in flight is restored or resumed.
   */
  async assignUnassignedDispatches(): Promise<void> {
    for (const sender of this.defaultSenders.values()) {
      const assigned = await this.store.assignUnassignedDispatches(sender.ref);
      if (assigned > 0) {
        this.logger.info(
          { chain: sender.ref.chain, sender: sender.ref.address, assigned },
          "assigned Dispatches stored with no Sender to their chain's default Sender",
        );
      }
    }
  }

  private async processClaimedDispatches(
    sender: CoordinatorSender,
    dispatches: Dispatch[],
  ): Promise<void> {
    const fundingFailed = await this.runFundingCheck(sender, dispatches);

    const items: CallRef[] = [];
    for (const dispatch of dispatches) {
      for (let callIndex = 0; callIndex < dispatch.items.length; callIndex++) {
        if (!fundingFailed.has(callKey(dispatch.id, callIndex)))
          items.push({ dispatch, callIndex });
      }
    }
    if (items.length === 0) return;
    if (sender.handler.approval) await this.approvalFlow.admit(sender, items);
    else await this.processSenderBatch(sender, items);
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
  private async processSenderBatch(sender: CoordinatorSender, items: CallRef[]): Promise<void> {
    const { handler } = sender;
    const { chain } = sender.ref;
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

    // #11 (ADR-0038): a Bulk Dispatch is prepared on its own, with its
    // bulkCall — its chunks must never mix with other requests' items.
    // Everything else is prepared together, as before.
    const groups = new Map<string, (CallRef & { call: Call })[]>();
    for (const v of valid) {
      const key = v.dispatch.bulkCall ? v.dispatch.id : '';
      const group = groups.get(key);
      if (group) group.push(v);
      else groups.set(key, [v]);
    }
    for (const group of groups.values()) {
      await this.prepareAndSend(sender, group);
    }
  }

  private async prepareAndSend(
    sender: CoordinatorSender,
    valid: (CallRef & { call: Call })[],
  ): Promise<void> {
    const { handler } = sender;
    const { chain, address: senderAddress } = sender.ref;
    const bulkCall = valid[0]?.dispatch.bulkCall;
    const calls = valid.map((v) => v.call);
    const prepareResult = bulkCall
      ? await handler.prepare(calls, senderAddress, { bulkCall })
      : await handler.prepare(calls, senderAddress);
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

    const chunks = new Map<
      UnsignedTransaction,
      { prepared: PreparedTransaction; members: CallRef[] }
    >();
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

    await inPool([...chunks.values()], handler.maxConcurrentSends, (chunk) =>
      this.processChunk(sender, chunk.prepared, chunk.members),
    );
  }

  /**
   * Signs and broadcasts exactly once per real transaction — never once per
   * contributing Call — then fans the single resulting hash (or failure)
   * back out to every Call that shares it, giving each its own Transaction
   * row (CONTEXT.md: an Attempt/Transaction is about signed bytes, not
   * about which Calls happened to ride along in it).
   */
  private async processChunk(
    sender: CoordinatorSender,
    prepared: PreparedTransaction,
    members: CallRef[],
  ): Promise<void> {
    const { handler } = sender;
    const { chain, address: senderAddress } = sender.ref;
    const log = this.logger.child({ chain, sender: senderAddress, bundleSize: members.length });
    // #20 review: a heartbeat — this claim is alive, however slow the batch.
    await this.store.touchClaims([...new Set(members.map(({ dispatch }) => dispatch.id))]);

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

    // #20 (ADR-0041): write every member's Transaction down *before*
    // sending, under the hash the chain will report — so a crash or an
    // ambiguous failure after this point can never lose track of a
    // transaction that may land.
    const hashResult = handler.transactionHash(signResult.value);
    if (!hashResult.ok) {
      log.warn({ stage: 'transactionHash', error: hashResult.error }, 'call(s) failed');
      for (const { dispatch, callIndex } of members) {
        await this.store.recordCallFailure({
          dispatchId: dispatch.id,
          callIndex,
          chain,
          error: hashResult.error,
        });
      }
      return;
    }
    // One atomic write for every member: a crash can never leave a bundle half-recorded.
    const noted = await this.store.createTransactions(
      members.map(({ dispatch, callIndex }) => ({
        dispatchId: dispatch.id,
        callIndex,
        chain,
        signedBytes: signResult.value,
        hash: hashResult.value,
      })),
    );

    const broadcastResult = await handler.broadcast(signResult.value);
    if (!broadcastResult.ok) {
      if (isAmbiguousBroadcastFailure(broadcastResult.error)) {
        // It may have reached the node: stays PENDING — polling, Base's
        // rebroadcast of the identical bytes, and abandonment resolve it.
        log.warn(
          { stage: 'broadcast', error: broadcastResult.error },
          'broadcast ambiguous — left PENDING',
        );
        return;
      }
      log.warn({ stage: 'broadcast', error: broadcastResult.error }, 'call(s) failed');
      for (const row of noted) await this.store.markFailed(row.id, broadcastResult.error);
      return;
    }

    log.info({ hash: broadcastResult.value.hash }, 'call(s) broadcast succeeded');
    for (const row of noted) {
      await this.store.recordSent(row.id, broadcastResult.value.hash, broadcastResult.value.sentAt);
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
  private async runFundingCheck(
    sender: CoordinatorSender,
    dispatches: Dispatch[],
  ): Promise<Set<string>> {
    const { handler } = sender;
    const { chain, address: senderAddress } = sender.ref;
    const approval = handler.approval;
    const failedKeys = new Set<string>();
    const requirements = new Map<string, FundingRequirement>();

    for (const dispatch of dispatches) {
      dispatch.items.forEach((item, callIndex) => {
        if (!item.payment) return;
        const { asset, amount } = item.payment;
        // #11: a Bulk Call ERC-20 item spends its aggregator's balance, not the Sender's.
        const fundedBy = item.fundedBy ?? null;
        // A control character, not a real asset symbol, so an asset name can never collide with the delimiter.
        const key = `${fundedBy ?? ''}\u0000${asset}`;
        const existing = requirements.get(key);
        if (existing) {
          existing.required += BigInt(amount);
          existing.items.push({ dispatch, callIndex });
        } else {
          requirements.set(key, {
            fundedBy,
            asset,
            required: BigInt(amount),
            items: [{ dispatch, callIndex }],
          });
        }
      });
    }

    // #40 (ADR-0043): what sending costs beyond the payments themselves
    // (fees, rent), paid by the Sender in the chain's native asset. Shared
    // by every Call of the batch, so a shortfall fails them all.
    // ADR-0054: a Multisig Sender's cost is paid by the proposer key (member key or executor), not the vault or Safe.
    if (approval || handler.networkCost) {
      const refs = dispatches.flatMap((dispatch) =>
        dispatch.items.map((_item, callIndex) => ({ dispatch, callIndex })),
      );
      const calls = refs.flatMap(({ dispatch, callIndex }) => {
        const call = dispatch.items[callIndex]?.call;
        return call ? [call] : [];
      });
      const cost = approval
        ? await approval.estimateApprovalCost(calls, senderAddress)
        : await handler.networkCost?.(calls, senderAddress);
      if (cost && !cost.ok) {
        this.logger.warn(
          { chain, sender: senderAddress, error: cost.error },
          'funding check: networkCost failed, failing affected calls',
        );
        await this.failFundingItems(refs, cost.error, failedKeys);
      } else if (cost) {
        const fundedBy = approval ? approval.proposerAddress : null;
        const key = `${fundedBy ?? ''}\u0000${cost.value.asset}`;
        const existing = requirements.get(key);
        requirements.set(key, {
          fundedBy,
          asset: cost.value.asset,
          required: (existing?.required ?? 0n) + BigInt(cost.value.amount),
          items: refs,
          ...(approval ? { holder: 'proposer' as const } : {}),
        });
      }
    }

    // ADR-0053/0054: what this Sender's open Proposals already hold back, read once per holder per check.
    const committedCache = new Map<CommittedHolder, Promise<AssetAmount[]>>();
    const committedFor = (holder: CommittedHolder) => {
      let cached = committedCache.get(holder);
      if (!cached) {
        const window = sender.approvalRewatchWindowMs ?? this.approvalRewatchWindowMs;
        const timedOutSince = new Date(this.now().getTime() - window);
        cached = this.store.listCommitted(chain, holder, timedOutSince, senderAddress);
        committedCache.set(holder, cached);
      }
      return cached;
    };

    for (const { fundedBy, asset, required, items, holder } of requirements.values()) {
      // A Multisig Sender's payments come out of the vault or Safe, less what open Proposals already hold.
      const committedHolder: CommittedHolder | null = approval
        ? (holder ?? (fundedBy === null ? 'sender' : null))
        : null;
      const address = fundedBy ?? senderAddress;

      const balanceResult = await handler.getBalance(address, asset);
      if (!balanceResult.ok) {
        this.logger.warn(
          { chain, sender: senderAddress, asset, error: balanceResult.error },
          'funding check: getBalance failed, failing affected calls',
        );
        await this.failFundingItems(items, balanceResult.error, failedKeys);
        continue;
      }

      const committed = committedHolder
        ? BigInt(
            (await committedFor(committedHolder)).find((c) => c.asset === asset)?.amount ?? '0',
          )
        : 0n;
      const available = BigInt(balanceResult.value.amount) - committed;
      if (available < required) {
        const short = (required - available).toString();
        this.logger.warn(
          {
            chain,
            sender: senderAddress,
            asset,
            required: required.toString(),
            available: available.toString(),
            committed: committed.toString(),
            short,
          },
          'funding check: insufficient balance, failing affected calls',
        );
        await this.failFundingItems(
          items,
          {
            code: 'INSUFFICIENT_FUNDS',
            message: `insufficient ${asset} balance`,
            chainDetail:
              approval && committedHolder
                ? {
                    asset,
                    short,
                    holder: approval.holders[committedHolder],
                    address,
                    committed: committed.toString(),
                  }
                : fundedBy
                  ? { asset, short, fundedBy }
                  : { asset, short },
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
      if (failedKeys.has(callKey(dispatch.id, callIndex))) continue; // already failed by another requirement
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
  /**
   * #20 (ADR-0041): resumes work a crashed worker claimed but never
   * finished. Only items with no Transaction are processed again — and
   * since nothing is ever sent without its Transaction written down first,
   * such an item was never sent, so this can't pay twice. Reclaimed items
   * skip the Funding Check (it ran at the original claim).
   */
  async reclaimStaleClaims(limit: number): Promise<void> {
    const claimedBefore = new Date(this.now().getTime() - STALE_CLAIM_MS);
    // A claim from before named Senders (or by a store call that named none) still needs its Sender.
    await this.assignUnassignedDispatches();

    for (const dispatch of await this.store.reclaimStaleDispatches(
      this.enabledChains,
      claimedBefore,
      limit,
    )) {
      if (this.inFlight.has(dispatch.id)) continue; // merely slow, not crashed: this Coordinator is still on it
      const sender = this.senderOfDispatch(dispatch);
      if (!sender) {
        this.logger.warn(
          { dispatchId: dispatch.id, chain: dispatch.chain, sender: dispatch.senderAddress },
          'a stale claim belongs to a Sender that is no longer configured; it resumes once that Sender is configured again',
        );
        continue;
      }
      const sent = new Set(
        (await this.store.listTransactions(dispatch.id)).map((t) => t.callIndex),
      );
      const unsent = dispatch.items
        .map((_, callIndex) => ({ dispatch, callIndex }))
        .filter(({ callIndex }) => !sent.has(callIndex));
      this.logger.warn(
        { dispatchId: dispatch.id, unsent: unsent.length },
        'reclaiming a stale claim',
      );
      this.inFlight.add(dispatch.id);
      try {
        if (sender.handler.approval) {
          // ADR-0054: a multisig Call is never signed as the Sender; it is noted and proposed.
          await this.approvalFlow.admit(sender, unsent);
        } else {
          await this.processSenderBatch(sender, unsent);
        }
      } finally {
        this.inFlight.delete(dispatch.id);
      }
    }

    for (const relayDispatch of await this.store.reclaimStaleRelayDispatches(
      this.enabledChains,
      claimedBefore,
      limit,
    )) {
      this.logger.warn(
        { relayDispatchId: relayDispatch.id },
        'reclaiming a stale relay dispatch claim',
      );
      await this.processRelayDispatch(relayDispatch);
    }
  }

  /**
   * #20 review (ADR-0041): once, at worker start — hands each Chain
   * Handler that keeps an in-memory nonce counter the signed bytes of every
   * Transaction still in flight on its chain, so a restart never hands out
   * a nonce one of them (possibly written down but never sent) holds.
   */
  async restoreReservations(): Promise<void> {
    const signedByHandler = new Map<ChainHandler, string[]>();
    const add = (handler: ChainHandler, signed: string): void => {
      signedByHandler.set(handler, [...(signedByHandler.get(handler) ?? []), signed]);
    };
    for (const chain of this.enabledChains) {
      const chainHandler = this.requireChainHandler(chain);
      signedByHandler.set(chainHandler, signedByHandler.get(chainHandler) ?? []);
      for (const sender of this.senders.filter((s) => s.ref.chain === chain)) {
        signedByHandler.set(sender.handler, signedByHandler.get(sender.handler) ?? []);
      }
      // ADR-0060: each Sender's handler gets only its own Sender's transactions.
      for (const transaction of await this.store.listUnsettledTransactions(chain)) {
        if (transaction.signedBytes)
          add(await this.handlerFor(transaction), transaction.signedBytes);
      }
      // ADR-0054: a propose transaction written down but maybe never sent holds a nonce too.
      for (const proposal of await this.unsettledProposals(chain)) {
        const sender = this.senderByKey.get(
          senderKey({ chain, address: proposal.senderAddress as SenderAddress }),
        );
        if (proposal.proposeSignedBytes)
          add(sender?.handler ?? chainHandler, proposal.proposeSignedBytes);
      }
    }
    for (const [handler, signed] of signedByHandler) {
      if (!handler.restoreInFlight) continue;
      await handler.restoreInFlight(signed);
      this.logger.info(
        { chain: handler.chain, restored: signed.length },
        'restored handler state from in-flight transactions',
      );
    }
  }

  /** `chain`'s Proposals that are not yet settled (`noted`, `open` or `executing`). */
  private async unsettledProposals(chain: Chain) {
    if (!this.senders.some((s) => s.ref.chain === chain && s.handler.approval)) return [];
    // Postgres's timestamptz stops at year 294276; JavaScript's latest Date is past it.
    const farFuture = new Date('9999-12-31T00:00:00.000Z');
    const proposals = await this.store.listProposalsDue([chain], farFuture, 10_000);
    return proposals.filter((p) => ['noted', 'open', 'executing'].includes(p.phase));
  }

  /**
   * #57: work on a chain that is not enabled is never loaded, so it waits
   * silently. This names each such chain and how much is waiting, so an
   * operator can see why it isn't moving.
   */
  async reportWorkOnDisabledChains(): Promise<void> {
    const disabled = CHAINS.filter((chain) => !this.chainHandlers.has(chain));
    if (disabled.length === 0) return;
    for (const [chain, waiting] of await this.store.countWaitingWork(disabled)) {
      this.logger.warn(
        { chain, waiting },
        'work is waiting on a chain that is not enabled; it resumes once the chain is enabled again',
      );
    }
  }

  async processQueuedRelayDispatches(limit: number): Promise<void> {
    const relayDispatches = await this.store.claimQueuedRelayDispatches(this.enabledChains, limit);
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

    // #20 (ADR-0041): written down (and linked) before it is ever sent.
    const hashResult = handler.transactionHash(relayDispatch.signedTransaction);
    if (!hashResult.ok) {
      log.warn({ error: hashResult.error }, 'relay dispatch hash failed');
      const failed = await this.store.recordCallFailure({
        dispatchId: relayDispatch.id,
        callIndex: 0,
        chain: relayDispatch.chain,
        error: hashResult.error,
      });
      await this.store.setRelayDispatchTransaction(relayDispatch.id, failed.id);
      return;
    }
    const transaction = await this.store.createTransaction({
      dispatchId: relayDispatch.id,
      callIndex: 0,
      chain: relayDispatch.chain,
      signedBytes: relayDispatch.signedTransaction,
      hash: hashResult.value,
    });
    await this.store.setRelayDispatchTransaction(relayDispatch.id, transaction.id);

    let broadcastResult: Awaited<ReturnType<ChainHandler['broadcast']>> | undefined;
    // Once any attempt may have reached the node, a later refusal can mean
    // "it already arrived" ("already known", "nonce too low").
    let sawAmbiguous = false;
    for (let attempt = 0; attempt < RELAY_BROADCAST_MAX_ATTEMPTS; attempt++) {
      log.debug({ attempt }, 'broadcasting relay dispatch');
      broadcastResult = await handler.broadcast(relayDispatch.signedTransaction);
      if (broadcastResult.ok) break;
      if (isAmbiguousBroadcastFailure(broadcastResult.error)) sawAmbiguous = true;
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

    if (broadcastResult?.ok === true) {
      log.info({ hash: broadcastResult.value.hash }, 'relay dispatch broadcast succeeded');
      await this.store.recordSent(
        transaction.id,
        broadcastResult.value.hash,
        broadcastResult.value.sentAt,
      );
      return;
    }
    const error = broadcastResult?.error ?? {
      code: 'RPC_UNAVAILABLE' as const,
      message: 'broadcast was never attempted',
    };
    if (sawAmbiguous || isAmbiguousBroadcastFailure(error)) {
      log.warn({ error }, 'relay dispatch broadcast ambiguous — left PENDING');
      return;
    }
    log.warn({ error }, 'relay dispatch broadcast failed');
    await this.store.markFailed(transaction.id, error);
  }

  /**
   * Advances up to `limit` still-PENDING Transactions: checks on-chain
   * status via the Chain Handler, and — with Retry Policy off — marks one
   * ABANDONED once it's been PENDING longer than its chain's timeout. That
   * timeout applies even when the status check itself fails (e.g. RPC
   * unavailable) — elapsed time is all ADR-0004 measures, so a chain having
   * connectivity trouble must not silently suppress abandonment forever.
   * #9 (ADR-0037): on a chain opted into `stuckHandling`, a transaction pending
   * past `stuckAfterMs` is fee-bumped or rebroadcast first (see
   * handleIfStuck), and Retry Policy on suppresses abandonment only while
   * it can still be bumped.
   */
  async pollPendingTransactions(limit: number): Promise<void> {
    this.bundleStatusCache.clear();
    const pending = await this.store.listPendingTransactions(this.enabledChains, limit);
    this.logger.debug({ count: pending.length, limit }, 'polling pending transactions');

    // A bundled broadcast's member rows share one hash: once one of them
    // has been bumped/rebroadcast (for all of them), the rest of this
    // tick's stale copies must not act on that hash again.
    const handledHashes = new Set<string>();
    const expired = new Map<ChainHandler, Transaction[]>();
    for (const transaction of pending) {
      if (transaction.hash && handledHashes.has(transaction.hash)) continue;
      const outcome = await this.resolvePendingTransaction(transaction);
      if (outcome === 'expired') {
        const handler = await this.handlerFor(transaction);
        expired.set(handler, [...(expired.get(handler) ?? []), transaction]);
      }
      if (outcome && transaction.hash) handledHashes.add(transaction.hash);
    }

    // ADR-0042, mainnet review: each resubmission's send can wait out a
    // whole validity window, so they share their Sender's send pool
    // (ADR-0044, ADR-0060), every Sender's at once, rather than stalling the
    // tick one by one.
    await Promise.all(
      [...expired].map(([handler, transactions]) =>
        inPool(transactions, handler.maxConcurrentSends, (transaction) =>
          this.resubmitExpired(transaction, this.transactionLogger(transaction)),
        ),
      ),
    );
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
    this.bundleStatusCache.clear();
    const abandoned = await this.store.listAbandonedTransactions(
      this.enabledChains,
      limit,
      notAbandonedBefore,
    );
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
      const confirmed = await this.store.listRecentlyConfirmedTransactions(
        chain,
        limit,
        notConfirmedBefore,
      );
      this.logger.debug(
        { chain, count: confirmed.length, limit },
        'rechecking recently confirmed transactions',
      );

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
    const handler = await this.handlerFor(transaction);
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
      if (transaction.proposalId) {
        // ADR-0053: a proposal whose execute was reorged out may be executable again, so never FAILED.
        await this.approvalFlow.abandonAfterReorg(transaction);
        return;
      }
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

  /** Returns whether stuck handling acted on this transaction's hash, or `'expired'` for the caller to resubmit — either way its bundled siblings skip it this tick. */
  private async resolvePendingTransaction(transaction: Transaction): Promise<boolean | 'expired'> {
    const log = this.transactionLogger(transaction);
    const resolved = await this.tryResolveVersions(transaction, log);
    if (resolved === 'expired') return 'expired';
    if (resolved) return false;

    const stuck = await this.handleIfStuck(transaction, log);
    if (stuck === 'bumped') return true; // now REPLACED: its replacement carries the clock from here

    // Either still PENDING on-chain, or the status check itself failed (e.g.
    // RPC unavailable) — either way, fall through to the ABANDONED timeout.
    // That timeout is a pure elapsed-time decision (ADR-0004: "the engine
    // stopped watching without a definitive outcome"), so it must not be
    // gated behind a successful status check — a chain having connectivity
    // trouble is exactly a case where the engine should eventually stop
    // watching, not one where the timeout silently never fires.
    await this.maybeAbandon(transaction, log);
    return stuck === 'handled';
  }

  /**
   * #9 (ADR-0037): acts on a transaction still PENDING `stuckAfterMs` after
   * its latest broadcast, on a chain opted into `stuckHandling`. Bumps it when it
   * can still be bumped; otherwise (Retry Policy off, a Relay Dispatch, the
   * cap reached, or a bump attempt that just failed) rebroadcasts its
   * identical bytes — free, and a no-op for the chain if it already has
   * them. A `NONCE_ALREADY_USED` bump failure means some version already
   * landed: stop, and let resolution find it.
   */
  private async handleIfStuck(
    transaction: Transaction,
    log: Logger,
  ): Promise<'none' | 'bumped' | 'handled'> {
    const config = this.stuckHandling.get(transaction.chain);
    const lastSentAt = transaction.lastBroadcastAt ?? transaction.broadcastAt;
    if (!config || !lastSentAt) return 'none';
    if (this.now().getTime() - lastSentAt.getTime() < config.stuckAfterMs) return 'none';

    const sender = await this.senderOfTransaction(transaction);
    if (
      sender &&
      this.canStillBump(transaction, sender) &&
      (await this.retryPolicyFor(transaction))
    ) {
      const outcome = await this.bump(transaction, sender, config, log);
      if (outcome !== 'failed') return outcome;
    }
    await this.rebroadcast(transaction, log);
    return 'handled';
  }

  /**
   * Whether this transaction's chain can bump it, its Sender is configured
   * (only its own key can sign a replacement) and its Call hasn't used up its
   * bump attempts — Retry Policy aside.
   */
  private canStillBump(transaction: Transaction, sender: CoordinatorSender | undefined): boolean {
    const config = this.stuckHandling.get(transaction.chain);
    return (
      config !== undefined &&
      sender?.handler.prepareReplacement !== undefined &&
      transaction.feeBumpAttempts < config.maxFeeBumps
    );
  }

  private async bump(
    transaction: Transaction,
    sender: CoordinatorSender,
    config: StuckHandlingConfig,
    log: Logger,
  ): Promise<'bumped' | 'handled' | 'failed'> {
    const { hash, signedBytes } = this.requireBroadcast(transaction);
    const { handler } = sender;
    // ADR-0054: a Proposal's execute is signed by the proposer, never the multisig Sender.
    const senderAddress =
      transaction.proposalId && handler.approval
        ? handler.approval.proposerAddress
        : sender.ref.address;
    const members = await this.pendingMembersOf(hash);
    const recordAttempts = async (feeBumpAttempts: number) => {
      for (const member of members) await this.store.setFeeBumpAttempts(member.id, feeBumpAttempts);
    };

    const stopBumping = async (error: DispatchError): Promise<boolean> => {
      const reason = BUMPING_STOPS_ON[error.code];
      if (reason === undefined) return false;
      log.info({ error }, `fee-bump: ${reason}, bumping stops`);
      await recordAttempts(config.maxFeeBumps);
      return true;
    };

    const prepared = await handler.prepareReplacement!(signedBytes, senderAddress);
    const signed = prepared.ok ? await handler.sign(prepared.value, senderAddress) : prepared;
    if (!signed.ok && (await stopBumping(signed.error))) return 'handled';
    const replacementHash = signed.ok ? handler.transactionHash(signed.value) : signed;
    if (!signed.ok || !replacementHash.ok) {
      const error = !replacementHash.ok ? replacementHash.error : undefined;
      log.warn(
        { error, feeBumpAttempts: transaction.feeBumpAttempts + 1 },
        'fee-bump attempt failed — counted against the cap, retried next time it is stuck',
      );
      await recordAttempts(transaction.feeBumpAttempts + 1);
      return 'failed';
    }

    // #20 (ADR-0041): the replacement is written down before it is sent.
    const replacements: Transaction[] = [];
    for (const member of members) {
      replacements.push(
        await this.store.createReplacementTransaction(member.id, {
          signedBytes: signed.value,
          hash: replacementHash.value,
        }),
      );
    }
    const broadcast = await handler.broadcast(signed.value);
    if (broadcast.ok) {
      log.info(
        { replacementHash: broadcast.value.hash },
        'fee-bump: replacement broadcast at the same nonce',
      );
      for (const replacement of replacements)
        await this.store.recordSent(replacement.id, broadcast.value.hash, broadcast.value.sentAt);
      return 'bumped';
    }
    if (isAmbiguousBroadcastFailure(broadcast.error)) {
      // It may have reached the node (or is already pooled): the replacement stays written down, PENDING.
      log.warn(
        { error: broadcast.error },
        'fee-bump: replacement broadcast ambiguous — left PENDING',
      );
      return 'bumped';
    }
    // Definitely refused: undo it, so the original is the live version again.
    for (const replacement of replacements) await this.store.undoReplacement(replacement.id);
    if (await stopBumping(broadcast.error)) return 'handled';
    log.warn(
      { error: broadcast.error, feeBumpAttempts: transaction.feeBumpAttempts + 1 },
      'fee-bump attempt failed — counted against the cap, retried next time it is stuck',
    );
    await recordAttempts(transaction.feeBumpAttempts + 1);
    return 'failed';
  }

  /**
   * ADR-0042: this transaction provably can never land, so its Calls are
   * resubmitted as a new Transaction — every PENDING row sharing the hash
   * together, since a bundle expires as one. The Calls are re-prepared
   * from the Dispatch, and each new Transaction is written down before it
   * is sent (ADR-0041). The dead predecessor is DROPPED at once. A Relay
   * Dispatch (no key) or a Call out of resubmissions is FAILED instead.
   */
  private async resubmitExpired(transaction: Transaction, log: Logger): Promise<void> {
    const { hash } = this.requireBroadcast(transaction);
    const chain = transaction.chain;
    const members = await this.pendingMembersOf(hash);
    // ADR-0054: an execute transaction is rebuilt by the approval capability, not from the Dispatch's items.
    if (members.some((m) => m.proposalId !== null)) {
      await this.approvalFlow.resubmitExpiredExecution(members, MAX_EXPIRY_RESUBMISSIONS, log);
      return;
    }
    // ADR-0060: a bundle never mixes Senders, so the first member's Sender re-signs them all.
    const sender = await this.senderOfTransaction(transaction);
    const refs: { member: Transaction; call: Call }[] = [];
    for (const member of members) {
      const call = (await this.store.getDispatch(member.dispatchId))?.items[member.callIndex]?.call;
      // No Dispatch: a Relay Dispatch — only its own signer could re-sign it. No Sender: one no longer configured.
      if (!call || !sender || member.feeBumpAttempts >= MAX_EXPIRY_RESUBMISSIONS) {
        log.warn(
          { transactionId: member.id, resubmissions: member.feeBumpAttempts },
          'expired transaction not resubmitted — failed',
        );
        await this.store.markFailed(member.id, expiredError(chain));
        continue;
      }
      refs.push({ member, call });
    }
    if (refs.length === 0 || !sender) return;

    const { handler } = sender;
    const senderAddress = sender.ref.address;
    const prepared = await handler.prepare(
      refs.map((r) => r.call),
      senderAddress,
    );
    if (!prepared.ok) {
      log.warn({ error: prepared.error }, 'resubmission prepare failed — failed');
      for (const { member } of refs) await this.store.markFailed(member.id, prepared.error);
      return;
    }

    const chunks = new Map<
      UnsignedTransaction,
      { prepared: PreparedTransaction; members: Transaction[] }
    >();
    prepared.value.forEach((p, i) => {
      const member = refs[i]?.member;
      if (!member)
        throw new Error(
          `prepare() returned more PreparedTransactions than Calls for chain ${chain}.`,
        );
      const chunk = chunks.get(p.unsignedTransaction);
      if (chunk) chunk.members.push(member);
      else chunks.set(p.unsignedTransaction, { prepared: p, members: [member] });
    });

    for (const chunk of chunks.values()) {
      const signed = await handler.sign(chunk.prepared, senderAddress);
      if (!signed.ok && signed.error.code === 'SIGNER_REFUSED') {
        // ADR-0046: refused on purpose, so retrying cannot help, and the original can never land.
        log.warn({ error: signed.error }, 'resubmission refused by the Signer — failed');
        for (const member of chunk.members) await this.store.markFailed(member.id, signed.error);
        continue;
      }
      const newHash = signed.ok ? handler.transactionHash(signed.value) : signed;
      if (!signed.ok || !newHash.ok) {
        // The original can't land, so nothing is lost: retried next tick.
        log.warn(
          { error: newHash.ok ? undefined : newHash.error },
          'resubmission signing failed — still pending, retried next tick',
        );
        continue;
      }

      // ADR-0041: written down before it is sent.
      const replacements: Transaction[] = [];
      for (const member of chunk.members) {
        replacements.push(
          await this.store.createReplacementTransaction(member.id, {
            signedBytes: signed.value,
            hash: newHash.value,
          }),
        );
        await this.store.markDropped(member.id);
      }
      const broadcast = await handler.broadcast(signed.value);
      if (broadcast.ok) {
        log.info({ resubmittedHash: broadcast.value.hash }, 'expired transaction resubmitted');
        for (const replacement of replacements)
          await this.store.recordSent(replacement.id, broadcast.value.hash, broadcast.value.sentAt);
      } else if (isAmbiguousBroadcastFailure(broadcast.error)) {
        log.warn({ error: broadcast.error }, 'resubmission broadcast ambiguous — left PENDING');
      } else {
        log.warn({ error: broadcast.error }, 'resubmission refused — failed');
        for (const replacement of replacements)
          await this.store.markFailed(replacement.id, broadcast.error);
      }
    }
  }

  private async rebroadcast(transaction: Transaction, log: Logger): Promise<void> {
    const { hash, signedBytes } = this.requireBroadcast(transaction);
    const result = await (await this.handlerFor(transaction)).broadcast(signedBytes);
    // A refused resend — e.g. "already known", or "nonce too low" once some
    // version landed — is never evidence against the transaction
    // (resolution/timeout decide), but it's still recorded as an Attempt:
    // that's what restarts the stuck clock, so a stuck transaction is
    // resent once per stuckAfterMs, never once per tick.
    if (result.ok) log.debug('rebroadcast identical bytes');
    else log.info({ error: result.error }, 'rebroadcast not accepted — still pending');
    for (const member of await this.pendingMembersOf(hash)) {
      await this.store.recordBroadcast(
        member.id,
        result.ok ? result.value.hash : hash,
        result.ok ? undefined : result.error,
      );
    }
  }

  /** Every still-PENDING Transaction sharing `hash` — several when one bundled broadcast covered several Calls. */
  private async pendingMembersOf(hash: string): Promise<Transaction[]> {
    return (await this.store.listTransactionsByHash(hash)).filter((t) => t.status === 'PENDING');
  }

  private requireBroadcast(transaction: Transaction): { hash: string; signedBytes: string } {
    if (!transaction.hash || !transaction.signedBytes) {
      throw new Error(`Transaction ${transaction.id} is PENDING but was never broadcast.`);
    }
    return { hash: transaction.hash, signedBytes: transaction.signedBytes };
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
    const resolved = await this.tryResolveVersions(transaction, log);
    if (resolved === 'expired') {
      // ADR-0030: provably never landed. Too late to resubmit an abandoned Call.
      await this.store.markFailed(transaction.id, expiredError(transaction.chain));
      log.info('previously-ABANDONED transaction provably expired');
    } else if (resolved) {
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
   * #9 (ADR-0037): a fee-bumped Call has several versions at one nonce and
   * any of them may be the one that lands, so every REPLACED ancestor is
   * checked too; whichever reports a definitive outcome settles the Call
   * and the others become DROPPED. ADR-0042: `'expired'` when nothing
   * settled and the latest version provably can never land.
   */
  private async tryResolveVersions(
    transaction: Transaction,
    log: Logger,
  ): Promise<boolean | 'expired'> {
    const versions =
      transaction.replacesTransactionId === null
        ? [transaction]
        : [
            transaction,
            ...(await this.store.listTransactions(transaction.dispatchId)).filter(
              (t) => t.callIndex === transaction.callIndex && t.status === 'REPLACED',
            ),
          ];

    let latestExpired = false;
    for (const version of versions) {
      const settled = await this.tryResolveByStatus(version, log);
      if (settled === 'expired') {
        if (version.id === transaction.id) latestExpired = true;
        continue;
      }
      if (!settled) continue;
      for (const other of versions) {
        if (other.id !== version.id) await this.store.markDropped(other.id);
      }
      return true;
    }
    return latestExpired ? 'expired' : false;
  }

  private async tryResolveByStatus(
    transaction: Transaction,
    log: Logger,
  ): Promise<boolean | 'expired'> {
    if (!transaction.hash) {
      throw new Error(
        `Transaction ${transaction.id} has no hash — only a broadcast Transaction should ever reach status resolution.`,
      );
    }

    const handler = await this.handlerFor(transaction);
    const bundled = await this.bundleSlotStatus(handler, transaction, transaction.hash);
    if (bundled?.ok && bundled.value.slotStatus.status === 'FAILED') {
      const { slot, slotStatus } = bundled.value;
      log.info({ settledHash: transaction.hash, slot }, 'bundled item failed');
      await this.store.markFailed(transaction.id, {
        code: 'CHAIN_REJECTED',
        message: `${transaction.chain} reported bundled item ${slot} as failed`,
        chainDetail: { slot, ...(slotStatus.detail as object | undefined) },
      });
      return true;
    }
    const statusResult = bundled
      ? bundled.ok
        ? ok(bundled.value.slotStatus.status)
        : bundled
      : await handler.getStatus(transaction.hash);

    if (statusResult.ok && statusResult.value === 'CONFIRMED') {
      log.info({ settledHash: transaction.hash }, 'transaction confirmed');
      await this.store.markConfirmed(transaction.id);
      return true;
    }

    if (statusResult.ok && statusResult.value === 'EXPIRED') {
      log.info({ expiredHash: transaction.hash }, 'transaction provably expired');
      return 'expired';
    }

    if (statusResult.ok && statusResult.value === 'FAILED') {
      if (transaction.proposalId) {
        // ADR-0054: a still-approved Proposal is not FAILED while it can still execute.
        return this.approvalFlow.failExecution(transaction, {
          code: 'CHAIN_REJECTED',
          message: `${transaction.chain} reported this transaction as failed`,
        });
      }
      log.info({ settledHash: transaction.hash }, 'transaction failed');
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

  /**
   * #11 (ADR-0038): a Bulk Dispatch member's own outcome — its slot in the
   * bundle is its rank by callIndex among the rows sharing the chunk's hash
   * (chunks never span Dispatches, and prepare keeps order). Undefined for
   * anything that isn't a bundled member. Traces are cached for the poll
   * tick: every member of a chunk asks about the same hash.
   */
  private async bundleSlotStatus(
    handler: ChainHandler,
    transaction: Transaction,
    hash: string,
  ): Promise<Result<{ slot: number; slotStatus: BundleSlotStatus }, DispatchError> | undefined> {
    if (!handler.getBundleStatus) return undefined;
    // A proposal's execute is one transaction for the whole proposal, not a Bulk Call bundle: its failure
    // goes through the approval flow (ADR-0053), never straight to FAILED.
    if (transaction.proposalId) return undefined;
    const dispatch = await this.store.getDispatch(transaction.dispatchId);
    // allowFailure false (the default): the transaction's own status is
    // every member's status — a revert fails them all, no trace needed.
    if (!dispatch?.bulkCall?.allowFailure) return undefined;

    const members = (await this.store.listTransactionsByHash(hash))
      .filter((t) => t.dispatchId === transaction.dispatchId)
      .sort((a, b) => a.callIndex - b.callIndex);
    const slot = members.findIndex((t) => t.callIndex === transaction.callIndex);

    let pending = this.bundleStatusCache.get(hash);
    if (!pending) {
      pending = handler.getBundleStatus(hash);
      this.bundleStatusCache.set(hash, pending);
    }
    const result = await pending;
    if (!result.ok) return result;
    // Empty: the chain doesn't know the transaction yet — still pending.
    if (result.value.length === 0) return ok({ slot, slotStatus: { status: 'PENDING' } });
    const slotStatus = result.value[slot];
    if (!slotStatus) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `bundle ${hash} has no slot ${slot}`,
        chainDetail: { slots: result.value.length },
      });
    }
    return ok({ slot, slotStatus });
  }

  /**
   * Whether this Transaction's Call opted into Retry Policy. A RelayDispatch
   * has no retryPolicy concept at all (nothing for the engine to fee-bump
   * with, ADR-0031) — the same as `false`.
   */
  private async retryPolicyFor(transaction: Transaction): Promise<boolean> {
    const dispatch = await this.store.getDispatch(transaction.dispatchId);
    if (dispatch) return dispatch.retryPolicy;

    // relay-dispatch issue 01: a RelayDispatch's Transaction.dispatchId
    // points at its own (non-Dispatch) row, so getDispatch legitimately
    // finds nothing for it — confirm that's actually why before treating
    // the miss as harmless, so a genuinely orphaned Managed Dispatch
    // Transaction (a real data-integrity bug) still throws loudly instead
    // of silently degrading into "abandon on timeout."
    const relayDispatch = await this.store.getRelayDispatch(transaction.dispatchId);
    if (!relayDispatch) {
      throw new Error(
        `Transaction ${transaction.id} references unknown Dispatch ${transaction.dispatchId}.`,
      );
    }
    return false;
  }

  private async maybeAbandon(transaction: Transaction, log: Logger): Promise<void> {
    // Opted in and still bumpable: fee-bumping, not abandonment, is this
    // transaction's way out (ADR-0003/0037). Anywhere it can't be bumped —
    // a chain without fee-bump, or the cap reached — Retry Policy on means
    // nothing more than off does, so the normal timeout applies.
    const retryPolicy = await this.retryPolicyFor(transaction);
    if (
      retryPolicy &&
      this.canStillBump(transaction, await this.senderOfTransaction(transaction))
    ) {
      return;
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
        `No ChainHandler registered for chain: ${chain}. Work for a chain that is not enabled is never loaded (#57), so reaching this is a bug.`,
      );
    }
    return handler;
  }

  private requireSender(ref: SenderRef): CoordinatorSender {
    const sender = this.senderByKey.get(senderKey(ref));
    if (!sender) throw new Error(`No Sender ${ref.address} configured on chain ${ref.chain}`);
    return sender;
  }

  /** ADR-0060: the configured Sender a Dispatch pays from (its chain's default when it names none), or undefined when it is no longer configured. */
  private senderOfDispatch(dispatch: Dispatch): CoordinatorSender | undefined {
    if (dispatch.senderAddress === null) return this.defaultSenders.get(dispatch.chain);
    return this.senderByKey.get(
      senderKey({ chain: dispatch.chain, address: dispatch.senderAddress }),
    );
  }

  /** The Sender whose Dispatch a Transaction belongs to; undefined for a Relay Dispatch's, or a Sender no longer configured. */
  private async senderOfTransaction(
    transaction: Transaction,
  ): Promise<CoordinatorSender | undefined> {
    const dispatch = await this.store.getDispatch(transaction.dispatchId);
    return dispatch ? this.senderOfDispatch(dispatch) : undefined;
  }

  /**
   * The handler that sent a Transaction, and so the one that can tell what
   * became of it (Solana proves expiry from what its own instance saw): its
   * Sender's, else its chain's.
   */
  private async handlerFor(transaction: Transaction): Promise<ChainHandler> {
    return (
      (await this.senderOfTransaction(transaction))?.handler ??
      this.requireChainHandler(transaction.chain)
    );
  }
}

/** The single-Sender shape (`senderAddresses`): one default Sender per chain that has an address. */
function singleSenders(deps: CoordinatorDeps): CoordinatorSender[] {
  return [...deps.chainHandlers].flatMap(([chain, handler]) => {
    const address = deps.senderAddresses?.get(chain);
    if (!address) return [];
    return [
      {
        ref: { chain, address: address as SenderAddress },
        handler,
        isDefault: true,
        approvalDeadlineMs: deps.approvalDeadlineMsByChain?.get(chain),
        approvalRewatchWindowMs: deps.approvalRewatchWindowMsByChain?.get(chain),
      },
    ];
  });
}

/** #42 (ADR-0044): runs `task` over `items`, at most `limit` at a time (one when unset). */
async function inPool<T>(
  items: T[],
  limit: number | undefined,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Math.min(queue.length, Math.max(1, limit ?? 1));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
    }),
  );
}

function expiredError(chain: Chain): DispatchError {
  return {
    code: 'CHAIN_REJECTED',
    message: `${chain} transaction expired without landing and was not resubmitted`,
  };
}

function callKey(dispatchId: string, callIndex: number): string {
  return `${dispatchId}:${callIndex}`;
}
