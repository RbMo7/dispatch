import type { Logger } from 'pino';

import type {
  ApprovalCapability,
  ChainHandler,
  ProposalSnapshot,
} from '../chain-handler/chain-handler.js';
import type { Chain } from '../domain/chain.js';
import type { Dispatch } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { Proposal } from '../domain/proposal.js';
import type { Transaction } from '../domain/transaction.js';
import type { DispatchStore } from '../repository/dispatch-store.js';

/** ADR-0054: how long Approvers have before the engine stops waiting and abandons the Calls (ADR-0053). */
export const DEFAULT_APPROVAL_DEADLINE_MS = 72 * 60 * 60 * 1000;

/** How many `UNPROPOSED` rows one pass reads: far above a Dispatch's size, so a Dispatch is planned whole. */
const UNPROPOSED_PAGE = 1000;

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

/** How often a Proposal is read when its chain does not say (`ApprovalCapability.watchIntervalMs`). */
export const DEFAULT_WATCH_INTERVAL_MS = 15_000;
/** After a failed execute is reopened, how long before the next try: a persistently failing execute is not hammered every tick. */
const EXECUTE_RETRY_DELAY_MS = 60_000;
/** A timed-out Proposal waits for the re-watch window (#88); until that exists it is only parked, not read. */
const TIMED_OUT_PARK_MS = 60 * 60 * 1000;

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
  /** Per-chain deadlines, taking precedence over `approvalDeadlineMs`. */
  approvalDeadlineMsByChain?: Map<Chain, number> | undefined;
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
  private readonly approvalDeadlineMsByChain: Map<Chain, number>;
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
    this.approvalDeadlineMsByChain = deps.approvalDeadlineMsByChain ?? new Map<Chain, number>();
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
        deadlineAt: new Date(
          this.now().getTime() +
            (this.approvalDeadlineMsByChain.get(chain) ?? this.approvalDeadlineMs),
        ),
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

  // ---------------------------------------------------------------------
  // The watch half (ADR-0054, ADR-0053): decide what each Proposal needs next.
  // ---------------------------------------------------------------------

  /**
   * Reads the Proposals whose `nextCheckAt` has passed, up to `limit`, and
   * moves each as far as it can go. One Proposal failing never stops the rest.
   */
  async watch(limit: number): Promise<void> {
    const chains = this.chains();
    if (chains.length === 0) return;
    for (const proposal of await this.store.listProposalsDue(chains, this.now(), limit)) {
      try {
        await this.watchOne(proposal);
      } catch (error) {
        this.logger.error({ err: error, proposalId: proposal.id }, 'watching a proposal failed');
        await this.backOff(proposal, 'unexpected error').catch(() => undefined);
      }
    }
  }

  private async watchOne(proposal: Proposal): Promise<void> {
    const approval = this.requireHandler(proposal.chain).approval;
    if (!approval) return;
    switch (proposal.phase) {
      case 'noted':
        return this.watchNoted(proposal, approval);
      case 'open':
        return this.watchOpen(proposal, approval);
      case 'executing':
        return this.watchExecuting(proposal, approval);
      case 'timed_out':
        // #88 owns the re-watch window; until then a timed-out Proposal is only parked.
        await this.reschedule(proposal, TIMED_OUT_PARK_MS);
        return;
      case 'resolved':
        return;
    }
  }

  /** `noted`: the propose transaction may never have been sent (a crash, a failed send), so send the same persisted bytes again. */
  private async watchNoted(proposal: Proposal, approval: ApprovalCapability): Promise<void> {
    const log = this.logger.child({ proposalId: proposal.id, chain: proposal.chain });
    // A proposal that never got confirmed sent and is past its deadline is not worth sending now: its
    // approvers' time is over. It may still have landed earlier, so it is ABANDONED, not FAILED (ADR-0053).
    if (this.deadlinePassed(proposal)) return this.timeOut(proposal);
    if (!proposal.proposeSignedBytes || !proposal.proposeHash) {
      log.error('noted proposal has no persisted propose bytes; cannot re-send');
      await this.backOff(proposal, 'no propose bytes');
      return;
    }
    const submitted = await approval.submitProposal({
      signedBytes: proposal.proposeSignedBytes,
      hash: proposal.proposeHash,
    });
    if (!submitted.ok) {
      log.warn({ error: submitted.error }, 'noted proposal re-send failed; backing off');
      await this.backOff(proposal, submitted.error.code);
      return;
    }
    log.info('noted proposal sent; now open');
    await this.store.updateProposal(proposal.id, {
      phase: 'open',
      checkFailures: 0,
      nextCheckAt: this.after(this.cadence(approval)),
    });
  }

  /** `open`: the order matters and is fixed (ADR-0053): someone else executed it, rejected, deadline, then execute. */
  private async watchOpen(proposal: Proposal, approval: ApprovalCapability): Promise<void> {
    const log = this.logger.child({ proposalId: proposal.id, chain: proposal.chain });
    const read = await approval.readProposal(proposal.chainRef);
    if (!read.ok) {
      // The deadline is elapsed time only: a chain that cannot be read must not keep a Proposal waiting forever.
      if (this.deadlinePassed(proposal)) return this.timeOut(proposal);
      log.warn({ error: read.error }, 'readProposal failed; backing off');
      await this.backOff(proposal, read.error.code);
      return;
    }
    const snapshot = read.value;
    const current = await this.store.updateProposal(proposal.id, {
      approvals: snapshot.approvals,
      threshold: snapshot.threshold,
      approvalState: snapshot.status === 'approved' ? 'approved' : 'awaiting',
      executeAfter: snapshot.executeAfter ?? proposal.executeAfter,
      checkFailures: 0,
    });

    // (1) Executed by someone else: the money moved, whatever the deadline says.
    if (snapshot.status === 'executed') {
      log.info({ executedHash: snapshot.executedHash }, 'proposal executed by someone else');
      await this.store.settleProposal(proposal.id, {
        status: 'CONFIRMED',
        ...(snapshot.executedHash === undefined ? {} : { hash: snapshot.executedHash }),
      });
      return;
    }
    // (2) Rejected, cancelled, or stale and not approved (an approved stale one is just `approved`).
    if (
      snapshot.status === 'rejected' ||
      snapshot.status === 'cancelled' ||
      snapshot.status === 'stale'
    ) {
      log.info({ status: snapshot.status }, 'proposal rejected');
      await this.store.settleProposal(proposal.id, {
        status: 'FAILED',
        error: {
          code: 'APPROVAL_REJECTED',
          message:
            snapshot.status === 'stale'
              ? 'the proposal was invalidated by a multisig change before it was approved'
              : `the proposal was ${snapshot.status} by its Approvers`,
          chainDetail: { status: snapshot.status },
        },
      });
      return;
    }
    // (3) The deadline, before any execute: a late approval is never executed (ADR-0053).
    if (this.deadlinePassed(current)) return this.timeOut(current);
    // (4) Approved, and past any time lock: execute.
    if (
      snapshot.status === 'approved' &&
      (current.executeAfter === null || this.now() >= current.executeAfter)
    ) {
      return this.execute(current, approval, snapshot);
    }
    await this.reschedule(current, this.cadence(approval));
  }

  private async timeOut(proposal: Proposal): Promise<void> {
    this.logger.warn(
      { proposalId: proposal.id, chain: proposal.chain, deadlineAt: proposal.deadlineAt },
      'proposal not decided by its deadline; calls abandoned and never executed by the engine',
    );
    await this.store.settleProposal(proposal.id, {
      status: 'ABANDONED',
      error: {
        code: 'APPROVAL_TIMEOUT',
        message: 'the proposal was not approved before its deadline; check it before sending again',
        chainDetail: { deadlineAt: proposal.deadlineAt.toISOString() },
      },
    });
    await this.store.updateProposal(proposal.id, { nextCheckAt: this.after(TIMED_OUT_PARK_MS) });
  }

  /** Sign as the proposer, write down (ADR-0041), then broadcast; the Coordinator's poll loop takes over from `PENDING`. */
  private async execute(
    proposal: Proposal,
    approval: ApprovalCapability,
    snapshot: ProposalSnapshot,
  ): Promise<void> {
    const handler = this.requireHandler(proposal.chain);
    const log = this.logger.child({ proposalId: proposal.id, chain: proposal.chain });

    const prepared = await approval.prepareExecution(proposal);
    if (!prepared.ok) {
      log.warn({ error: prepared.error }, 'prepareExecution failed; retrying until the deadline');
      // Even a definite refusal (a simulation) can clear while the Proposal stays approved.
      await this.backOff(proposal, prepared.error.code);
      return;
    }
    const signed = await handler.sign(prepared.value, approval.proposerAddress);
    if (!signed.ok) {
      if (signed.error.code === 'SIGNER_REFUSED') {
        // ADR-0046: deliberate, so retrying cannot help.
        log.warn({ error: signed.error }, 'execute refused by the Signer; calls failed');
        await this.store.settleProposal(proposal.id, { status: 'FAILED', error: signed.error });
        return;
      }
      log.warn({ error: signed.error }, 'signing the execute failed; retrying next time');
      await this.backOff(proposal, signed.error.code);
      return;
    }
    const hash = handler.transactionHash(signed.value);
    if (!hash.ok) {
      log.warn({ error: hash.error }, 'hashing the execute failed; retrying next time');
      await this.backOff(proposal, hash.error.code);
      return;
    }

    // ADR-0041: the signed execute is written down, the Calls PENDING, before anything is sent.
    const rows = await this.store.markProposalExecuting(proposal.id, signed.value, hash.value);
    await this.reschedule(proposal, this.cadence(approval));
    log.info({ hash: hash.value, approvals: snapshot.approvals }, 'executing approved proposal');

    const sent = await handler.broadcast(signed.value);
    if (sent.ok) {
      for (const row of rows) await this.store.recordSent(row.id, sent.value.hash);
      return;
    }
    if (sent.error.code === 'RPC_UNAVAILABLE' || sent.error.code === 'ALREADY_KNOWN') {
      log.warn({ error: sent.error }, 'execute broadcast ambiguous; left PENDING');
      return;
    }
    log.warn({ error: sent.error }, 'execute broadcast refused');
    const first = rows[0];
    if (first) await this.failExecution(first, sent.error);
  }

  /** `executing`: the Coordinator's poll loop owns the execute transaction; this only ends the Proposal once its Calls are final. */
  private async watchExecuting(proposal: Proposal, approval: ApprovalCapability): Promise<void> {
    const calls = await this.store.listProposalCalls(proposal.id);
    if (calls.length > 0 && calls.every((c) => c.status === 'FAILED')) {
      // A crash between failing the Calls and deciding what next.
      if (!(await this.failOrReopen(proposal, approval, null))) {
        await this.backOff(proposal, 'readProposal failed');
      }
      return;
    }
    if (calls.every((c) => c.status === 'CONFIRMED' || c.status === 'FAILED')) {
      await this.store.updateProposal(proposal.id, { phase: 'resolved', resolvedAt: this.now() });
      return;
    }
    await this.reschedule(proposal, this.cadence(approval));
  }

  /**
   * The execute transaction of `transaction`'s Proposal failed on-chain (or
   * was refused at broadcast). A Squads Proposal that is still approved and
   * before its deadline is not failed: its Calls go back to
   * `AWAITING_APPROVAL` and the watch loop executes it again. Anything else
   * fails the Calls. Returns false when that cannot be decided yet (the
   * Proposal could not be read, or this is an older version), leaving the
   * Calls `PENDING` to be checked again.
   */
  async failExecution(transaction: Transaction, error: DispatchError): Promise<boolean> {
    const proposalId = transaction.proposalId;
    if (!proposalId) throw new Error(`Transaction ${transaction.id} has no Proposal`);
    const proposal = await this.store.getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown proposal ${proposalId}`);
    const approval = this.requireHandler(proposal.chain).approval;
    if (!approval) throw new Error(`Chain ${proposal.chain} has no approval capability`);

    const current = (await this.store.listProposalCalls(proposalId)).find(
      (c) => c.callIndex === transaction.callIndex,
    );
    // An older (REPLACED) version failing says nothing about the live one.
    if (!current || current.id !== transaction.id) return false;
    // Already handled this tick through a sibling that shared the same send.
    if (current.status !== 'PENDING' || current.hash !== transaction.hash) return true;

    this.logger.warn(
      { proposalId, failedHash: transaction.hash, error },
      'execute transaction failed',
    );
    return this.failOrReopen(proposal, approval, error);
  }

  private async failOrReopen(
    proposal: Proposal,
    approval: ApprovalCapability,
    error: DispatchError | null,
  ): Promise<boolean> {
    const calls = await this.store.listProposalCalls(proposal.id);
    const pending = calls.filter((c) => c.status === 'PENDING');
    let retry = false;
    if (approval.reexecuteOnFailure && !this.deadlinePassed(proposal)) {
      const read = await approval.readProposal(proposal.chainRef);
      if (!read.ok) return false; // cannot tell whether it can still execute: never report FAILED yet
      retry = read.value.status === 'approved';
    }
    // A Call that will be executed again is never marked FAILED, not even for an instant: a poll
    // (or a crash) in between would report a terminal failure for a proposal that can still pay
    // (ADR-0053). The Calls go straight from PENDING back to AWAITING_APPROVAL.
    if (retry && calls.every((c) => c.status === 'PENDING' || c.status === 'FAILED')) {
      this.logger.info(
        { proposalId: proposal.id },
        'execute failed but the proposal is still approved; will execute again',
      );
      await this.store.reopenProposalForExecution(proposal.id);
      await this.store.updateProposal(proposal.id, {
        checkFailures: 0,
        nextCheckAt: this.after(EXECUTE_RETRY_DELAY_MS),
      });
      return true;
    }
    if (error) {
      for (const call of pending) await this.store.markFailed(call.id, error);
    }
    await this.store.updateProposal(proposal.id, { phase: 'resolved', resolvedAt: this.now() });
    return true;
  }

  /**
   * An execute transaction that provably expired (Solana, ADR-0042): the
   * Calls are resubmitted as a new transaction rebuilt by
   * `prepareExecution`, not from the Dispatch's items, since a Proposal's
   * transaction is not made of them. `members` all share one hash.
   */
  async resubmitExpiredExecution(
    members: Transaction[],
    maxResubmissions: number,
    log: Logger,
  ): Promise<void> {
    const first = members[0];
    const proposalId = first?.proposalId;
    if (!first || !proposalId) return;
    const proposal = await this.store.getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown proposal ${proposalId}`);
    const handler = this.requireHandler(proposal.chain);
    const approval = handler.approval;
    if (!approval) throw new Error(`Chain ${proposal.chain} has no approval capability`);

    if (members.some((m) => m.feeBumpAttempts >= maxResubmissions)) {
      log.warn({ proposalId }, 'expired execute out of resubmissions');
      await this.failExecution(first, {
        code: 'CHAIN_REJECTED',
        message: `${proposal.chain} execute transaction expired without landing and was not resubmitted`,
      });
      return;
    }
    const prepared = await approval.prepareExecution(proposal);
    if (!prepared.ok) {
      if (isTransient(prepared.error)) {
        log.warn(
          { error: prepared.error },
          'execute resubmission prepare failed; retried next tick',
        );
      } else {
        log.warn({ error: prepared.error }, 'execute resubmission prepare failed');
        await this.failExecution(first, prepared.error);
      }
      return;
    }
    const signed = await handler.sign(prepared.value, approval.proposerAddress);
    if (!signed.ok) {
      if (signed.error.code === 'SIGNER_REFUSED') {
        log.warn({ error: signed.error }, 'execute resubmission refused by the Signer — failed');
        for (const member of members) await this.store.markFailed(member.id, signed.error);
        await this.store.updateProposal(proposalId, { phase: 'resolved', resolvedAt: this.now() });
      } else {
        log.warn({ error: signed.error }, 'execute resubmission signing failed; retried next tick');
      }
      return;
    }
    const newHash = handler.transactionHash(signed.value);
    if (!newHash.ok) {
      log.warn({ error: newHash.error }, 'execute resubmission hashing failed; retried next tick');
      return;
    }

    // ADR-0041: written down before it is sent; the dead predecessor is dropped at once.
    const replacements: Transaction[] = [];
    for (const member of members) {
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
      log.info({ resubmittedHash: broadcast.value.hash }, 'expired execute resubmitted');
      for (const replacement of replacements) {
        await this.store.recordSent(replacement.id, broadcast.value.hash);
      }
    } else if (
      broadcast.error.code === 'RPC_UNAVAILABLE' ||
      broadcast.error.code === 'ALREADY_KNOWN'
    ) {
      log.warn(
        { error: broadcast.error },
        'execute resubmission broadcast ambiguous — left PENDING',
      );
    } else {
      log.warn({ error: broadcast.error }, 'execute resubmission refused');
      const replacement = replacements[0];
      if (replacement) await this.failExecution(replacement, broadcast.error);
    }
  }

  private cadence(approval: ApprovalCapability): number {
    return approval.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  }

  private after(ms: number): Date {
    return new Date(this.now().getTime() + ms);
  }

  private deadlinePassed(proposal: Proposal): boolean {
    return this.now().getTime() >= proposal.deadlineAt.getTime();
  }

  private async reschedule(proposal: Proposal, ms: number): Promise<void> {
    await this.store.updateProposal(proposal.id, { nextCheckAt: this.after(ms) });
  }

  /** A read or send that could not be completed: the next try waits twice as long as the last, up to 5 minutes. */
  private async backOff(proposal: Proposal, reason: string): Promise<void> {
    const approval = this.requireHandler(proposal.chain).approval;
    const base = approval ? this.cadence(approval) : DEFAULT_WATCH_INTERVAL_MS;
    const failures = proposal.checkFailures + 1;
    const delay = Math.min(base * 2 ** Math.min(failures, 16), BACKOFF_MAX_MS);
    this.logger.debug({ proposalId: proposal.id, failures, delay, reason }, 'proposal backed off');
    await this.store.updateProposal(proposal.id, {
      checkFailures: failures,
      nextCheckAt: this.after(delay),
    });
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
