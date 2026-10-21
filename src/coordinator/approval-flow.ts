import type { Logger } from 'pino';

import type { ApprovalCapability, ChainHandler } from '../chain-handler/chain-handler.js';
import type { Chain } from '../domain/chain.js';
import type { Dispatch } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { Transaction } from '../domain/transaction.js';
import type { DispatchStore } from '../repository/dispatch-store.js';

/** ADR-0054: how long Approvers have before the engine stops waiting and abandons the Calls (ADR-0053). */
export const DEFAULT_APPROVAL_DEADLINE_MS = 72 * 60 * 60 * 1000;

/** How many `UNPROPOSED` rows one pass reads: far above a Dispatch's size, so a Dispatch is planned whole. */
const UNPROPOSED_PAGE = 1000;

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

/** A (Dispatch, callIndex) pointer to one Call, as the Coordinator groups claimed work. */
export type ApprovalCallRef = { dispatch: Dispatch; callIndex: number };

export type ApprovalFlowDeps = {
  store: DispatchStore;
  chainHandlers: ReadonlyMap<Chain, ChainHandler>;
  /** The multisig that is the Sender of `chain` (the vault or Safe). */
  requireSenderAddress: (chain: Chain) => string;
  now: () => Date;
  logger: Logger;
  /** How long a new Proposal waits for approval before it times out. Defaults to 72 hours. */
  approvalDeadlineMs?: number | undefined;
};

/** The same two reasons a retry can help: the Signer or the node could not be reached. Everything else is a definite answer. */
function isTransient(error: DispatchError): boolean {
  return error.code === 'SIGNER_UNREACHABLE' || error.code === 'RPC_UNAVAILABLE';
}

/**
 * ADR-0054: the chain-neutral state machine for a Multisig Sender, which the
 * Coordinator delegates to for any chain whose handler has an `approval`
 * capability. This is the propose half: Calls are written down `UNPROPOSED`,
 * then proposed one Dispatch at a time (a Proposal never mixes Dispatches).
 * Everything chain-specific stays behind `ApprovalCapability`.
 */
export class ApprovalFlow {
  private readonly store: DispatchStore;
  private readonly chainHandlers: ReadonlyMap<Chain, ChainHandler>;
  private readonly requireSenderAddress: (chain: Chain) => string;
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly approvalDeadlineMs: number;
  /** One creation at a time per Sender: the tail of each Sender's queue. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Per chain, in memory only: when proposing may be tried again after a transient failure. */
  private readonly backoff = new Map<Chain, { until: number; failures: number }>();

  constructor(deps: ApprovalFlowDeps) {
    this.store = deps.store;
    this.chainHandlers = deps.chainHandlers;
    this.requireSenderAddress = deps.requireSenderAddress;
    this.now = deps.now;
    this.logger = deps.logger.child({ component: 'approval-flow' });
    this.approvalDeadlineMs = deps.approvalDeadlineMs ?? DEFAULT_APPROVAL_DEADLINE_MS;
  }

  /** The chains whose handler has an approval capability. */
  chains(): Chain[] {
    return [...this.chainHandlers].flatMap(([chain, handler]) => (handler.approval ? [chain] : []));
  }

  /**
   * Validates each claimed Call and writes the valid ones down `UNPROPOSED`
   * (idempotent, so a reclaimed Dispatch never gets a duplicate row). An
   * invalid Call fails on its own, exactly as for a plain Sender.
   */
  async admit(chain: Chain, refs: ApprovalCallRef[]): Promise<void> {
    const handler = this.requireHandler(chain);
    const valid: ApprovalCallRef[] = [];
    for (const ref of refs) {
      const item = ref.dispatch.items[ref.callIndex];
      if (!item) continue;
      const validation = await handler.validateCall(item.call);
      if (!validation.ok) {
        this.logger.warn(
          { dispatchId: ref.dispatch.id, callIndex: ref.callIndex, chain, error: validation.error },
          'call failed validateCall',
        );
        await this.store.recordCallFailure({
          dispatchId: ref.dispatch.id,
          callIndex: ref.callIndex,
          chain,
          error: validation.error,
        });
        continue;
      }
      valid.push(ref);
    }
    if (valid.length === 0) return;
    await this.store.noteUnproposed(
      valid.map(({ dispatch, callIndex }) => ({ dispatchId: dispatch.id, callIndex, chain })),
    );
  }

  /** Proposes whatever `UNPROPOSED` work `chain` has room for, serialized per Sender. */
  proposeUnproposed(chain: Chain): Promise<void> {
    const sender = this.requireSenderAddress(chain);
    const key = `${chain}\u0000${sender}`;
    const run = (this.queues.get(key) ?? Promise.resolve()).then(() =>
      this.proposeAll(chain, sender),
    );
    // The queue never rejects, so one failed pass cannot wedge the next.
    this.queues.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  private async proposeAll(chain: Chain, sender: string): Promise<void> {
    const approval = this.requireHandler(chain).approval;
    if (!approval) return;
    const log = this.logger.child({ chain });

    for (;;) {
      if (this.isBackedOff(chain)) return;
      if (!(await this.hasFreeSlot(approval, chain, sender))) return;

      const rows = await this.store.listUnproposed(chain, UNPROPOSED_PAGE);
      const first = rows[0];
      if (!first) return;
      // One Dispatch at a time (ADR-0054): the rows come first-claimed Dispatch first.
      const group = rows.filter((row) => row.dispatchId === first.dispatchId);
      const dispatch = await this.store.getDispatch(first.dispatchId);
      if (!dispatch) {
        throw new Error(`UNPROPOSED Transaction ${first.id} has no Dispatch ${first.dispatchId}`);
      }

      const calls = group.map((row) => {
        const item = dispatch.items[row.callIndex];
        if (!item) throw new Error(`Dispatch ${dispatch.id} has no item ${row.callIndex}`);
        return item.call;
      });

      const plan = approval.planBundles(calls);
      if (!plan.ok) {
        log.warn(
          { dispatchId: dispatch.id, error: plan.error },
          'planBundles failed; failing calls',
        );
        await this.failRows(group, plan.error);
        continue;
      }
      if (!isPartition(plan.value, group.length)) {
        log.error(
          { dispatchId: dispatch.id, plan: plan.value },
          'planBundles gave an invalid plan',
        );
        await this.failRows(group, {
          code: 'CHAIN_REJECTED',
          message: 'the chain handler could not plan this Dispatch into proposals',
        });
        continue;
      }

      for (const positions of plan.value) {
        if (!(await this.hasFreeSlot(approval, chain, sender))) return;
        const rowsOfBundle = positions.map((p) => group[p] as Transaction);
        const callsOfBundle = positions.map((p) => calls[p] as (typeof calls)[number]);
        const proceed = await this.proposeBundle(
          approval,
          chain,
          sender,
          rowsOfBundle,
          callsOfBundle,
        );
        if (!proceed) return;
      }
    }
  }

  /** Builds, signs, writes down and submits one Proposal. Returns false when proposing should stop for now. */
  private async proposeBundle(
    approval: ApprovalCapability,
    chain: Chain,
    sender: string,
    rows: Transaction[],
    calls: Parameters<ApprovalCapability['buildProposal']>[0]['calls'],
  ): Promise<boolean> {
    const dispatchId = rows[0]?.dispatchId as string;
    const log = this.logger.child({ chain, dispatchId, calls: rows.length });

    const built = await approval.buildProposal({ calls, sender });
    if (!built.ok) {
      return this.handleFailure(chain, rows, built.error, 'buildProposal', log);
    }

    // The Signer is asked as the proposer, never the Sender: a vault or Safe never signs here.
    const signed = await approval.signProposal(built.value);
    if (!signed.ok) {
      return this.handleFailure(chain, rows, signed.error, 'signProposal', log);
    }

    // ADR-0041: written down (and the Calls moved to AWAITING_APPROVAL) before anything is sent.
    let proposalId: string;
    try {
      const proposal = await this.store.createProposal({
        dispatchId,
        chain,
        senderAddress: sender,
        chainRef: built.value.chainRef,
        payload: built.value.payload,
        proposalRef: built.value.proposalRef,
        sequence: built.value.sequence,
        threshold: built.value.threshold,
        deadlineAt: new Date(this.now().getTime() + this.approvalDeadlineMs),
        executeAfter: built.value.executeAfter,
        proposeSignedBytes: signed.value.signedBytes,
        proposeHash: signed.value.hash,
        expected: built.value.expected,
        committed: built.value.committed,
        transactionIds: rows.map((row) => row.id),
      });
      proposalId = proposal.id;
    } catch (error) {
      // Nothing was written (it is atomic), so the rows stay UNPROPOSED. Not sent, so nothing to lose.
      log.error({ err: error }, 'createProposal failed; calls stay UNPROPOSED');
      this.noteTransientFailure(chain);
      return false;
    }

    const submitted = await approval.submitProposal(signed.value);
    if (!submitted.ok) {
      // The Proposal is `noted` with its bytes persisted: the watch loop re-sends the same bytes.
      log.warn(
        { proposalId, stage: 'submitProposal', error: submitted.error },
        'proposal written down but not confirmed sent; left noted',
      );
      this.noteTransientFailure(chain);
      return false;
    }

    this.backoff.delete(chain);
    log.info({ proposalId, proposalRef: built.value.proposalRef }, 'proposal created');
    return true;
  }

  /** A transient error leaves the rows `UNPROPOSED` and backs the chain off; a definite one fails them for good. */
  private async handleFailure(
    chain: Chain,
    rows: Transaction[],
    error: DispatchError,
    stage: string,
    log: Logger,
  ): Promise<boolean> {
    if (isTransient(error)) {
      log.warn(
        { stage, error },
        'proposing failed transiently; calls stay UNPROPOSED, backing off',
      );
      this.noteTransientFailure(chain);
      return false;
    }
    log.warn({ stage, error }, 'proposing failed; failing calls');
    await this.failRows(rows, error);
    return true;
  }

  private async failRows(rows: Transaction[], error: DispatchError): Promise<void> {
    for (const row of rows) await this.store.markFailed(row.id, error);
  }

  private async hasFreeSlot(
    approval: ApprovalCapability,
    chain: Chain,
    sender: string,
  ): Promise<boolean> {
    return (await this.store.countOpenProposals(chain, sender)) < approval.openProposalLimit;
  }

  private isBackedOff(chain: Chain): boolean {
    const state = this.backoff.get(chain);
    return state !== undefined && this.now().getTime() < state.until;
  }

  private noteTransientFailure(chain: Chain): void {
    const failures = (this.backoff.get(chain)?.failures ?? 0) + 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    this.backoff.set(chain, { until: this.now().getTime() + delay, failures });
  }

  private requireHandler(chain: Chain): ChainHandler {
    const handler = this.chainHandlers.get(chain);
    if (!handler) throw new Error(`No ChainHandler registered for chain: ${chain}`);
    return handler;
  }
}

/** Every position 0..size-1 appears in exactly one bundle, and no bundle is empty. */
function isPartition(plan: number[][], size: number): boolean {
  const seen = new Set<number>();
  for (const bundle of plan) {
    if (bundle.length === 0) return false;
    for (const position of bundle) {
      if (!Number.isInteger(position) || position < 0 || position >= size || seen.has(position)) {
        return false;
      }
      seen.add(position);
    }
  }
  return seen.size === size;
}
