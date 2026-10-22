import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { approvalLoop } from '../approval-loop.js';
import type {
  Balance,
  BroadcastResult,
  ChainHandler,
  ChainStatus,
  PreparedTransaction,
  ProposalSnapshot,
  SignedTransaction,
} from '../chain-handler/chain-handler.js';
import { FakeApproval } from '../chain-handler/test-support/fake-approval.js';
import type { Call, DispatchItem, Payment, SolanaCall } from '../domain/call.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { DEFAULT_APPROVAL_DEADLINE_MS, DEFAULT_WATCH_INTERVAL_MS } from './approval-flow.js';
import { Coordinator } from './coordinator.js';

const call = (n: number): SolanaCall => ({ programId: 'prog', accounts: [], data: `call-${n}` });
const item = (n: number): DispatchItem<'solana'> => ({ call: call(n), payment: null });

const HOUR = 60 * 60 * 1000;
const rpcDown: DispatchError = { code: 'RPC_UNAVAILABLE', message: 'node down' };
const signerDown: DispatchError = { code: 'SIGNER_UNREACHABLE', message: 'signer down' };
const signerRefused: DispatchError = { code: 'SIGNER_REFUSED', message: 'policy' };

const active = (extra: Partial<ProposalSnapshot> = {}): ProposalSnapshot => ({
  status: 'active',
  approvals: 1,
  threshold: 2,
  executable: false,
  ...extra,
});
const approved = (extra: Partial<ProposalSnapshot> = {}): ProposalSnapshot => ({
  status: 'approved',
  approvals: 2,
  threshold: 2,
  executable: true,
  ...extra,
});

/** A Chain Handler for a Multisig Sender whose sends are scriptable: each signature and hash is unique. */
class MultisigHandler implements ChainHandler<'solana'> {
  readonly chain = 'solana';
  readonly approval = new FakeApproval<'solana'>();
  signed = 0;
  /** The hash of each signed execute, by its bytes. */
  statuses = new Map<string, ChainStatus>();
  defaultStatus: ChainStatus = 'PENDING';

  paymentToCall = vi.fn((_payment: Payment): Promise<Result<SolanaCall, DispatchError>> =>
    Promise.resolve(ok(call(0))),
  );
  validateCall = vi.fn((_call: Call): Promise<Result<void, DispatchError>> =>
    Promise.resolve(ok(undefined)),
  );
  validateSignedTransaction = vi.fn(
    (_signed: SignedTransaction): Promise<Result<void, DispatchError>> =>
      Promise.resolve(ok(undefined)),
  );
  prepare = vi.fn((): Promise<Result<PreparedTransaction[], DispatchError>> =>
    Promise.resolve(ok([])),
  );
  sign = vi.fn(
    (
      _prepared: PreparedTransaction,
      _signer: string,
    ): Promise<Result<SignedTransaction, DispatchError>> =>
      Promise.resolve(ok(`signed-${++this.signed}`)),
  );
  transactionHash = vi.fn((signed: SignedTransaction): Result<string, DispatchError> =>
    ok(`hash-of-${signed}`),
  );
  broadcast = vi.fn((signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>> =>
    Promise.resolve(ok({ hash: `hash-of-${signed}` })),
  );
  getStatus = vi.fn((hash: string): Promise<Result<ChainStatus, DispatchError>> =>
    Promise.resolve(ok(this.statuses.get(hash) ?? this.defaultStatus)),
  );
  getBalance = vi.fn((_address: string, asset: string): Promise<Result<Balance, DispatchError>> =>
    Promise.resolve(ok({ asset, amount: '1000000' })),
  );
  prepareReplacement = vi.fn((): Promise<Result<PreparedTransaction, DispatchError>> =>
    Promise.resolve(ok({ callIndex: 0, unsignedTransaction: 'replacement' })),
  );
  restoreInFlight = vi.fn((_signed: string[]): Promise<void> => Promise.resolve());
}

function setup(options: { stuck?: boolean } = {}) {
  let currentTime = new Date('2024-01-01T00:00:00.000Z');
  const clock = () => currentTime;
  const advance = (ms: number) => {
    currentTime = new Date(currentTime.getTime() + ms);
  };
  const store = new InMemoryDispatchStore(clock);
  const handler = new MultisigHandler();
  const makeCoordinator = () =>
    new Coordinator({
      store,
      chainHandlers: new Map([['solana', handler]]),
      senderAddresses: new Map([['solana', 'vault']]),
      abandonmentTimeoutMs: new Map([['solana', 600_000]]),
      ...(options.stuck
        ? { stuckHandling: new Map([['solana', { stuckAfterMs: 60_000, maxFeeBumps: 3 }]]) }
        : {}),
      now: clock,
      sleep: () => Promise.resolve(),
      logger: pino({ level: 'silent' }),
    });
  const coordinator = makeCoordinator();

  let keys = 0;
  const dispatch = (items: DispatchItem<'solana'>[], retryPolicy = false) =>
    store.createDispatch({ chain: 'solana', idempotencyKey: `key-${keys++}`, items, retryPolicy });
  const statuses = async (dispatchId: string) =>
    (await store.listTransactions(dispatchId))
      .filter((t) => !['REPLACED', 'DROPPED'].includes(t.status))
      .sort((a, b) => a.callIndex - b.callIndex)
      .map((t) => t.status);
  const proposalOf = async (dispatchId: string) => {
    const [proposal] = await store.listProposalsForDispatch(dispatchId);
    if (!proposal) throw new Error('no proposal');
    return proposal;
  };
  const rows = async (dispatchId: string) =>
    (await store.listTransactions(dispatchId)).sort((a, b) => a.callIndex - b.callIndex);

  /** Proposes a Dispatch, then watches it once so it is `open`. */
  const openProposal = async (items = [item(1), item(2)], retryPolicy = false) => {
    const d = await dispatch(items, retryPolicy);
    await coordinator.processQueuedDispatches(10);
    await coordinator.watchProposals(10);
    expect((await proposalOf(d.id)).phase).toBe('open');
    advance(DEFAULT_WATCH_INTERVAL_MS);
    return d;
  };

  return {
    now: clock,
    store,
    handler,
    approval: handler.approval,
    coordinator,
    makeCoordinator,
    advance,
    dispatch,
    statuses,
    proposalOf,
    rows,
    openProposal,
  };
}

describe('Coordinator.watchProposals: noted and open (ADR-0054)', () => {
  it("re-sends a noted proposal's persisted bytes and moves it to open", async () => {
    const { coordinator, approval, dispatch, proposalOf } = setup();
    approval.submitImpl = () => Promise.resolve(err(rpcDown)); // the first send does not go through
    const d = await dispatch([item(1)]);
    await coordinator.processQueuedDispatches(10);
    expect((await proposalOf(d.id)).phase).toBe('noted');
    approval.submitImpl = () => Promise.resolve(ok(undefined));
    approval.submitted.length = 0;

    await coordinator.watchProposals(10);

    expect(approval.submitted).toEqual([{ signedBytes: 'signed-prop-1', hash: 'hash-prop-1' }]);
    expect((await proposalOf(d.id)).phase).toBe('open');
  });

  it('a noted proposal whose first send failed is re-sent after a restart, never re-proposed', async () => {
    const { store, approval, makeCoordinator, dispatch, proposalOf } = setup();
    approval.submitImpl = () => Promise.resolve(err(rpcDown));
    const d = await dispatch([item(1)]);
    await makeCoordinator().processQueuedDispatches(10);
    expect((await proposalOf(d.id)).phase).toBe('noted');

    // The worker restarts: a fresh Coordinator, a working node.
    approval.submitImpl = () => Promise.resolve(ok(undefined));
    const restarted = makeCoordinator();
    await restarted.watchProposals(10);

    expect((await proposalOf(d.id)).phase).toBe('open');
    expect(approval.built).toHaveLength(1);
    expect(await store.listProposalsForDispatch(d.id)).toHaveLength(1);
  });

  it('leaves a noted proposal alone until its next check is due, and backs off when the re-send fails', async () => {
    const { coordinator, approval, advance, dispatch, proposalOf } = setup();
    approval.submitImpl = () => Promise.resolve(err(rpcDown));
    const d = await dispatch([item(1)]);
    await coordinator.processQueuedDispatches(10);

    await coordinator.watchProposals(10);
    const first = await proposalOf(d.id);
    expect(first).toMatchObject({ phase: 'noted', checkFailures: 1 });

    const sends = approval.events.length;
    await coordinator.watchProposals(10); // not due yet
    expect(approval.events).toHaveLength(sends);

    advance(10 * 60 * 1000);
    await coordinator.watchProposals(10);
    expect((await proposalOf(d.id)).checkFailures).toBe(2);
  });

  it("records approvals, threshold and approval state from each snapshot, on the chain's own cadence", async () => {
    const { coordinator, approval, openProposal, proposalOf, advance } = setup();
    approval.watchIntervalMs = 60_000;
    const d = await openProposal();
    advance(60_000);
    approval.readImpl = () => Promise.resolve(ok(active({ approvals: 1, threshold: 3 })));

    await coordinator.watchProposals(10);
    expect(await proposalOf(d.id)).toMatchObject({
      approvals: 1,
      threshold: 3,
      approvalState: 'awaiting',
    });

    advance(30_000);
    const reads = vi.fn(approval.readImpl);
    approval.readImpl = reads;
    await coordinator.watchProposals(10);
    expect(reads).not.toHaveBeenCalled(); // 60 s cadence: not due yet

    advance(30_000);
    approval.readImpl = () =>
      Promise.resolve(
        ok(
          approved({
            approvals: 3,
            threshold: 3,
            executable: false,
            executeAfter: new Date('2999-01-01'),
          }),
        ),
      );
    await coordinator.watchProposals(10);
    expect(await proposalOf(d.id)).toMatchObject({ approvals: 3, approvalState: 'approved' });
  });
});

describe('Coordinator.watchProposals: approve, execute, confirm', () => {
  it('executes an approved proposal as the proposer, written down before it is sent, and confirms it', async () => {
    const {
      coordinator,
      store,
      handler,
      approval,
      openProposal,
      statuses,
      proposalOf,
      rows,
      advance,
    } = setup();
    const d = await openProposal([item(1), item(2)]);
    approval.readImpl = () => Promise.resolve(ok(approved()));
    let beforeSend: string[] = [];
    handler.broadcast.mockImplementationOnce(async (signed) => {
      // ADR-0041: by now the execute is persisted, the Calls PENDING with the execute's hash.
      beforeSend = (await rows(d.id)).map((t) => `${t.status}:${t.hash}:${t.signedBytes}`);
      return ok({ hash: `hash-of-${signed}` });
    });

    await coordinator.watchProposals(10);

    expect(handler.sign).toHaveBeenCalledWith(
      { callIndex: 0, unsignedTransaction: 'execute-prop-1' },
      'proposer-key',
    );
    expect(beforeSend).toEqual([
      'PENDING:hash-of-signed-1:signed-1',
      'PENDING:hash-of-signed-1:signed-1',
    ]);
    expect((await proposalOf(d.id)).phase).toBe('executing');
    expect(await statuses(d.id)).toEqual(['PENDING', 'PENDING']);
    expect(handler.broadcast).toHaveBeenCalledTimes(1);

    // The existing poll loop confirms it, and the next watch closes the proposal.
    handler.statuses.set('hash-of-signed-1', 'CONFIRMED');
    await coordinator.pollPendingTransactions(10);
    expect(await statuses(d.id)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(
      (await store.listProposalCalls((await proposalOf(d.id)).id)).map(
        (c) => c.confirmedAt !== null,
      ),
    ).toEqual([true, true]);
    advance(DEFAULT_WATCH_INTERVAL_MS);
    await coordinator.watchProposals(10);
    expect(await proposalOf(d.id)).toMatchObject({ phase: 'resolved' });
  });

  it('does not execute while a time lock holds, then does once it passes', async () => {
    const { coordinator, handler, approval, openProposal, advance, statuses, proposalOf } = setup();
    const d = await openProposal([item(1)]);
    const releaseAt = new Date('2024-01-01T01:00:00.000Z');
    approval.readImpl = () =>
      Promise.resolve(ok(approved({ executeAfter: releaseAt, executable: false })));

    await coordinator.watchProposals(10);
    expect(handler.sign).not.toHaveBeenCalled();
    expect(await statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
    expect((await proposalOf(d.id)).executeAfter).toEqual(releaseAt);

    advance(HOUR);
    approval.readImpl = () => Promise.resolve(ok(approved({ executeAfter: releaseAt })));
    await coordinator.watchProposals(10);
    expect(await statuses(d.id)).toEqual(['PENDING']);
  });

  it('executes a stale but approved proposal like any approved one', async () => {
    const { coordinator, approval, openProposal, statuses } = setup();
    const d = await openProposal([item(1)]);
    // A handler reports an approved proposal as `approved` even when a multisig change made it stale.
    approval.readImpl = () => Promise.resolve(ok(approved()));
    await coordinator.watchProposals(10);
    expect(await statuses(d.id)).toEqual(['PENDING']);
  });
});

describe('Coordinator.watchProposals: executed, rejected, stale, cancelled', () => {
  it('settles the Calls CONFIRMED, linking the hash, when someone else executed it', async () => {
    const { coordinator, handler, approval, openProposal, rows, proposalOf } = setup();
    const d = await openProposal([item(1), item(2)]);
    approval.readImpl = () =>
      Promise.resolve(
        ok({
          status: 'executed',
          approvals: 2,
          threshold: 2,
          executedHash: 'human-exec',
          executable: false,
        }),
      );

    await coordinator.watchProposals(10);

    expect((await rows(d.id)).map((t) => [t.status, t.hash])).toEqual([
      ['CONFIRMED', 'human-exec'],
      ['CONFIRMED', 'human-exec'],
    ]);
    expect((await proposalOf(d.id)).phase).toBe('resolved');
    expect(handler.sign).not.toHaveBeenCalled();
  });

  it('settles as executed even past the deadline: the money moved', async () => {
    const { coordinator, approval, openProposal, advance, statuses } = setup();
    const d = await openProposal([item(1)]);
    advance(DEFAULT_APPROVAL_DEADLINE_MS);
    approval.readImpl = () =>
      Promise.resolve(
        ok({
          status: 'executed',
          approvals: 2,
          threshold: 2,
          executedHash: 'late',
          executable: false,
        }),
      );
    await coordinator.watchProposals(10);
    expect(await statuses(d.id)).toEqual(['CONFIRMED']);
  });

  for (const status of ['rejected', 'cancelled', 'stale'] as const) {
    it(`fails the Calls with APPROVAL_REJECTED when the proposal is ${status}`, async () => {
      const { coordinator, handler, approval, openProposal, rows, proposalOf } = setup();
      const d = await openProposal([item(1), item(2)]);
      approval.readImpl = () =>
        Promise.resolve(ok({ status, approvals: 0, threshold: 2, executable: false }));

      await coordinator.watchProposals(10);

      const failed = await rows(d.id);
      expect(failed.map((t) => t.status)).toEqual(['FAILED', 'FAILED']);
      expect(failed.map((t) => t.error?.code)).toEqual(['APPROVAL_REJECTED', 'APPROVAL_REJECTED']);
      expect((await proposalOf(d.id)).phase).toBe('resolved');
      expect(handler.sign).not.toHaveBeenCalled();
    });
  }
});

describe('Coordinator.watchProposals: the deadline (ADR-0053)', () => {
  it('abandons the Calls with APPROVAL_TIMEOUT when nobody decided in time', async () => {
    const { coordinator, approval, openProposal, advance, rows, proposalOf } = setup();
    const d = await openProposal([item(1), item(2)]);
    approval.readImpl = () => Promise.resolve(ok(active()));

    await coordinator.watchProposals(10);
    expect((await rows(d.id)).map((t) => t.status)).toEqual([
      'AWAITING_APPROVAL',
      'AWAITING_APPROVAL',
    ]);

    advance(DEFAULT_APPROVAL_DEADLINE_MS);
    await coordinator.watchProposals(10);

    const abandoned = await rows(d.id);
    expect(abandoned.map((t) => t.status)).toEqual(['ABANDONED', 'ABANDONED']);
    expect(abandoned.map((t) => t.error?.code)).toEqual(['APPROVAL_TIMEOUT', 'APPROVAL_TIMEOUT']);
    expect((await proposalOf(d.id)).phase).toBe('timed_out');
  });

  it('abandons a noted proposal whose send never succeeded once its deadline passes, without sending it again', async () => {
    const { coordinator, approval, advance, dispatch, proposalOf, rows } = setup();
    approval.submitImpl = () => Promise.resolve(err(rpcDown));
    const d = await dispatch([item(1)]);
    await coordinator.processQueuedDispatches(10);
    expect((await proposalOf(d.id)).phase).toBe('noted');
    const events = approval.events.length;

    advance(DEFAULT_APPROVAL_DEADLINE_MS);
    await coordinator.watchProposals(10);

    expect((await rows(d.id)).map((t) => [t.status, t.error?.code])).toEqual([
      ['ABANDONED', 'APPROVAL_TIMEOUT'],
    ]);
    expect(approval.events).toHaveLength(events);
    expect((await proposalOf(d.id)).phase).toBe('timed_out');
  });

  it('never executes a proposal approved after its deadline', async () => {
    const { coordinator, handler, approval, openProposal, advance, statuses, proposalOf } = setup();
    const d = await openProposal([item(1)]);
    advance(DEFAULT_APPROVAL_DEADLINE_MS + 1);
    approval.readImpl = () => Promise.resolve(ok(approved()));

    await coordinator.watchProposals(10);

    expect(await statuses(d.id)).toEqual(['ABANDONED']);
    expect(handler.sign).not.toHaveBeenCalled();
    expect(approval.prepareExecutionImpl).toBeDefined();
    expect((await proposalOf(d.id)).phase).toBe('timed_out');
  });

  it('times out on elapsed time alone when the proposal cannot be read', async () => {
    const { coordinator, approval, openProposal, advance, statuses } = setup();
    const d = await openProposal([item(1)]);
    approval.readImpl = () => Promise.resolve(err(rpcDown));

    await coordinator.watchProposals(10);
    expect(await statuses(d.id)).toEqual(['AWAITING_APPROVAL']);

    advance(DEFAULT_APPROVAL_DEADLINE_MS);
    await coordinator.watchProposals(10);
    expect(await statuses(d.id)).toEqual(['ABANDONED']);
  });

  it('parks a timed-out proposal instead of reading it every tick', async () => {
    const { coordinator, approval, openProposal, advance, proposalOf } = setup();
    const d = await openProposal([item(1)]);
    advance(DEFAULT_APPROVAL_DEADLINE_MS);
    await coordinator.watchProposals(10);
    const reads = vi.fn(approval.readImpl);
    approval.readImpl = reads;
    await coordinator.watchProposals(10);
    expect(reads).not.toHaveBeenCalled();
    expect((await proposalOf(d.id)).phase).toBe('timed_out');
  });
});

describe('Coordinator.watchProposals: backoff', () => {
  it('backs a proposal off on a failed read, longer each time, and recovers after a good read', async () => {
    const { coordinator, approval, openProposal, advance, proposalOf, now } = setup();
    const d = await openProposal([item(1)]);
    approval.readImpl = () => Promise.resolve(err(rpcDown));
    const gaps: number[] = [];

    for (let failures = 1; failures <= 3; failures++) {
      await coordinator.watchProposals(10);
      const p = await proposalOf(d.id);
      expect(p.checkFailures).toBe(failures);
      const gap = p.nextCheckAt.getTime() - now().getTime();
      gaps.push(gap);
      advance(gap);
    }
    expect(gaps[1]).toBeGreaterThan(gaps[0] as number);
    expect(gaps[2]).toBeGreaterThan(gaps[1] as number);

    approval.readImpl = () => Promise.resolve(ok(active()));
    await coordinator.watchProposals(10);
    expect((await proposalOf(d.id)).checkFailures).toBe(0);
  });

  it('one proposal failing does not stop the next', async () => {
    const { coordinator, approval, openProposal, dispatch, statuses, advance } = setup();
    const a = await openProposal([item(1)]);
    const b = await dispatch([item(2)]);
    await coordinator.processQueuedDispatches(10);
    await coordinator.watchProposals(10); // b noted -> open (a is read too, still active)
    advance(DEFAULT_WATCH_INTERVAL_MS);
    approval.readImpl = vi
      .fn<typeof approval.readImpl>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(ok({ status: 'rejected', approvals: 0, threshold: 2, executable: false }));
    await coordinator.watchProposals(10);
    // a threw; b (read second) was rejected. Only one of the two is settled, the other backed off.
    const all = [...(await statuses(a.id)), ...(await statuses(b.id))].sort();
    expect(all).toEqual(['AWAITING_APPROVAL', 'FAILED']);
  });
});

describe('Coordinator.watchProposals: the signer on execute', () => {
  it('fails the Calls on SIGNER_REFUSED and does not try again', async () => {
    const { coordinator, handler, approval, openProposal, advance, rows, proposalOf } = setup();
    const d = await openProposal([item(1)]);
    approval.readImpl = () => Promise.resolve(ok(approved()));
    handler.sign.mockResolvedValue(err(signerRefused));

    await coordinator.watchProposals(10);
    expect((await rows(d.id)).map((t) => [t.status, t.error?.code])).toEqual([
      ['FAILED', 'SIGNER_REFUSED'],
    ]);
    expect((await proposalOf(d.id)).phase).toBe('resolved');

    for (let i = 0; i < 3; i++) {
      advance(HOUR);
      await coordinator.watchProposals(10);
    }
    expect(handler.sign).toHaveBeenCalledTimes(1);
  });

  it('retries on SIGNER_UNREACHABLE, with backoff, leaving the Calls awaiting', async () => {
    const { coordinator, handler, approval, openProposal, advance, statuses, proposalOf } = setup();
    const d = await openProposal([item(1)]);
    approval.readImpl = () => Promise.resolve(ok(approved()));
    handler.sign.mockResolvedValueOnce(err(signerDown));

    await coordinator.watchProposals(10);
    expect(await statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
    expect((await proposalOf(d.id)).checkFailures).toBe(1);
    expect(handler.broadcast).not.toHaveBeenCalled();

    await coordinator.watchProposals(10); // backed off: not due
    expect(handler.sign).toHaveBeenCalledTimes(1);

    advance(HOUR);
    await coordinator.watchProposals(10);
    expect(await statuses(d.id)).toEqual(['PENDING']);
  });

  it('keeps retrying while prepareExecution fails, until the deadline abandons the Calls', async () => {
    const { coordinator, handler, approval, openProposal, advance, statuses } = setup();
    const d = await openProposal([item(1)]);
    approval.readImpl = () => Promise.resolve(ok(approved()));
    approval.prepareExecutionImpl = () =>
      Promise.resolve(
        err({ code: 'CHAIN_REJECTED', message: 'simulation failed: underfunded vault' }),
      );

    await coordinator.watchProposals(10);
    expect(await statuses(d.id)).toEqual(['AWAITING_APPROVAL']);

    advance(DEFAULT_APPROVAL_DEADLINE_MS);
    await coordinator.watchProposals(10);
    expect(await statuses(d.id)).toEqual(['ABANDONED']);
    expect(handler.sign).not.toHaveBeenCalled();
  });
});

describe('a failed execute (ADR-0053: FAILED only once the proposal can no longer execute)', () => {
  const failFirstExecute = async (s: ReturnType<typeof setup>) => {
    const d = await s.openProposal([item(1), item(2)]);
    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    await s.coordinator.watchProposals(10);
    s.handler.statuses.set('hash-of-signed-1', 'FAILED');
    return d;
  };

  it('is reopened and executed again while the proposal is still approved and before the deadline', async () => {
    const s = setup();
    const d = await failFirstExecute(s);

    await s.coordinator.pollPendingTransactions(10);

    // Never reported FAILED: back to waiting, with no hash.
    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL', 'AWAITING_APPROVAL']);
    expect((await s.rows(d.id)).map((t) => t.hash)).toEqual([null, null]);
    expect((await s.proposalOf(d.id)).phase).toBe('open');

    s.advance(HOUR);
    await s.coordinator.watchProposals(10);
    expect(await s.statuses(d.id)).toEqual(['PENDING', 'PENDING']);
    expect((await s.rows(d.id)).map((t) => t.hash)).toEqual([
      'hash-of-signed-2',
      'hash-of-signed-2',
    ]);

    s.handler.statuses.set('hash-of-signed-2', 'CONFIRMED');
    await s.coordinator.pollPendingTransactions(10);
    expect(await s.statuses(d.id)).toEqual(['CONFIRMED', 'CONFIRMED']);
  });

  it('never marks the Calls FAILED on the way to reopening them', async () => {
    const s = setup();
    const d = await failFirstExecute(s);
    const markFailed = vi.spyOn(s.store, 'markFailed');

    await s.coordinator.pollPendingTransactions(10);

    expect(markFailed).not.toHaveBeenCalled();
    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL', 'AWAITING_APPROVAL']);
  });

  it('abandons, never fails, the Calls once the deadline has passed while the proposal can still execute', async () => {
    const s = setup();
    const d = await failFirstExecute(s);
    s.advance(DEFAULT_APPROVAL_DEADLINE_MS);

    await s.coordinator.pollPendingTransactions(10);

    // Someone else may still execute it, so a FAILED here could make a caller pay twice (ADR-0053).
    expect((await s.rows(d.id)).map((t) => [t.status, t.error?.code, t.hash])).toEqual([
      ['ABANDONED', 'APPROVAL_TIMEOUT', null],
      ['ABANDONED', 'APPROVAL_TIMEOUT', null],
    ]);
    expect((await s.proposalOf(d.id)).phase).toBe('timed_out');
  });

  it('fails the Calls for good once the deadline has passed and the proposal was rejected', async () => {
    const s = setup();
    const d = await failFirstExecute(s);
    s.approval.readImpl = () =>
      Promise.resolve(ok({ status: 'rejected', approvals: 0, threshold: 2, executable: false }));
    s.advance(DEFAULT_APPROVAL_DEADLINE_MS);

    await s.coordinator.pollPendingTransactions(10);

    expect(await s.statuses(d.id)).toEqual(['FAILED', 'FAILED']);
    expect((await s.proposalOf(d.id)).phase).toBe('resolved');
  });

  it('settles the Calls CONFIRMED when someone else executed the proposal after the failed attempt', async () => {
    const s = setup();
    const d = await failFirstExecute(s);
    s.approval.readImpl = () =>
      Promise.resolve(
        ok({
          status: 'executed',
          approvals: 2,
          threshold: 2,
          executable: false,
          executedHash: 'their-hash',
        }),
      );

    await s.coordinator.pollPendingTransactions(10);

    expect((await s.rows(d.id)).map((t) => [t.status, t.hash])).toEqual([
      ['CONFIRMED', 'their-hash'],
      ['CONFIRMED', 'their-hash'],
    ]);
  });

  it('leaves the Calls PENDING when the proposal state is unknown', async () => {
    const s = setup();
    const d = await failFirstExecute(s);
    s.approval.readImpl = () =>
      Promise.resolve(ok({ status: 'unknown', approvals: 0, threshold: 2, executable: false }));

    await s.coordinator.pollPendingTransactions(10);

    expect(await s.statuses(d.id)).toEqual(['PENDING', 'PENDING']);
  });

  it('fails the Calls when the proposal is no longer approved', async () => {
    const s = setup();
    const d = await failFirstExecute(s);
    s.approval.readImpl = () =>
      Promise.resolve(ok({ status: 'cancelled', approvals: 0, threshold: 2, executable: false }));

    await s.coordinator.pollPendingTransactions(10);
    expect(await s.statuses(d.id)).toEqual(['FAILED', 'FAILED']);
  });

  it('is left PENDING, not failed, while the proposal cannot be read', async () => {
    const s = setup();
    const d = await failFirstExecute(s);
    s.approval.readImpl = () => Promise.resolve(err(rpcDown));

    await s.coordinator.pollPendingTransactions(10);
    expect(await s.statuses(d.id)).toEqual(['PENDING', 'PENDING']);

    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    await s.coordinator.pollPendingTransactions(10);
    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL', 'AWAITING_APPROVAL']);
  });

  it('a refused broadcast of the execute is treated the same way', async () => {
    const s = setup();
    const d = await s.openProposal([item(1)]);
    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    s.handler.broadcast.mockResolvedValueOnce(
      err({ code: 'CHAIN_REJECTED', message: 'simulation failed' }),
    );

    await s.coordinator.watchProposals(10);
    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
  });
});

describe('the execute transaction in the existing machinery', () => {
  it('survives a crash between writing the execute down and broadcasting it', async () => {
    const s = setup({ stuck: true });
    const d = await s.openProposal([item(1)]);
    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    s.handler.broadcast.mockRejectedValueOnce(new Error('process killed'));

    await s.coordinator.watchProposals(10); // the tick fails after the write
    expect(await s.statuses(d.id)).toEqual(['PENDING']);
    expect((await s.proposalOf(d.id)).phase).toBe('executing');
    s.handler.broadcast.mockClear();

    // Restart: a fresh Coordinator never re-proposes or re-executes; the stuck rebroadcast sends the same bytes.
    const restarted = s.makeCoordinator();
    s.advance(2 * 60_000);
    await restarted.pollPendingTransactions(10);

    expect(s.handler.broadcast).toHaveBeenCalledWith('signed-1');
    expect(s.handler.sign).toHaveBeenCalledTimes(1);
    s.handler.statuses.set('hash-of-signed-1', 'CONFIRMED');
    await restarted.pollPendingTransactions(10);
    expect(await s.statuses(d.id)).toEqual(['CONFIRMED']);
  });

  it('resubmits an execute whose blockhash expired by asking prepareExecution again, and drops the dead one', async () => {
    const s = setup();
    const d = await s.openProposal([item(1), item(2)]);
    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    await s.coordinator.watchProposals(10);
    const executions = vi.fn(s.approval.prepareExecutionImpl);
    s.approval.prepareExecutionImpl = executions;
    s.handler.statuses.set('hash-of-signed-1', 'EXPIRED');

    await s.coordinator.pollPendingTransactions(10);

    expect(executions).toHaveBeenCalledTimes(1);
    expect(s.handler.prepare).not.toHaveBeenCalled(); // never rebuilt from the Dispatch's items
    expect(s.handler.sign).toHaveBeenLastCalledWith(expect.anything(), 'proposer-key');
    const all = await s.store.listTransactions(d.id);
    expect(all.filter((t) => t.status === 'DROPPED')).toHaveLength(2);
    const live = all.filter((t) => t.status === 'PENDING');
    expect(live.map((t) => [t.hash, t.proposalId !== null, t.proposalPosition])).toEqual([
      ['hash-of-signed-2', true, 0],
      ['hash-of-signed-2', true, 1],
    ]);

    s.handler.statuses.set('hash-of-signed-2', 'CONFIRMED');
    await s.coordinator.pollPendingTransactions(10);
    expect(await s.statuses(d.id)).toEqual(['CONFIRMED', 'CONFIRMED']);
  });

  it('after its resubmissions are used up, a still-approved execute goes back to awaiting, not FAILED', async () => {
    const s = setup();
    const d = await s.openProposal([item(1)]);
    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    await s.coordinator.watchProposals(10);
    s.handler.defaultStatus = 'EXPIRED';

    for (let i = 0; i < 4; i++) await s.coordinator.pollPendingTransactions(10);

    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
  });

  it('a Signer refusal while resubmitting an expired execute fails the Calls', async () => {
    const s = setup();
    const d = await s.openProposal([item(1)]);
    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    await s.coordinator.watchProposals(10);
    s.handler.statuses.set('hash-of-signed-1', 'EXPIRED');
    s.handler.sign.mockResolvedValueOnce(err(signerRefused));

    await s.coordinator.pollPendingTransactions(10);
    expect((await s.rows(d.id)).map((t) => [t.status, t.error?.code])).toEqual([
      ['FAILED', 'SIGNER_REFUSED'],
    ]);
  });

  it("fee-bumps a stuck execute under the Dispatch's own Retry Policy, signed as the proposer", async () => {
    const s = setup({ stuck: true });
    const d = await s.openProposal([item(1)], true);
    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    await s.coordinator.watchProposals(10);
    s.advance(2 * 60_000);

    await s.coordinator.pollPendingTransactions(10);

    expect(s.handler.prepareReplacement).toHaveBeenCalledWith('signed-1', 'proposer-key');
    expect(s.handler.sign).toHaveBeenLastCalledWith(
      { callIndex: 0, unsignedTransaction: 'replacement' },
      'proposer-key',
    );
    expect((await s.store.listTransactions(d.id)).map((t) => t.status).sort()).toEqual([
      'PENDING',
      'REPLACED',
    ]);
  });

  it('a stuck execute is only rebroadcast when the Dispatch has Retry Policy off', async () => {
    const s = setup({ stuck: true });
    await s.openProposal([item(1)], false);
    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    await s.coordinator.watchProposals(10);
    s.handler.broadcast.mockClear();
    s.advance(2 * 60_000);

    await s.coordinator.pollPendingTransactions(10);
    expect(s.handler.prepareReplacement).not.toHaveBeenCalled();
    expect(s.handler.broadcast).toHaveBeenCalledWith('signed-1');
  });
});

describe('restoreReservations (ADR-0041)', () => {
  it('also hands the handler the propose bytes of proposals not yet settled', async () => {
    const s = setup();
    await s.dispatch([item(1)]);
    await s.coordinator.processQueuedDispatches(10);
    const settled = await s.dispatch([item(2)]);
    await s.coordinator.processQueuedDispatches(10);
    await s.coordinator.watchProposals(10);
    s.approval.readImpl = () =>
      Promise.resolve(ok({ status: 'rejected', approvals: 0, threshold: 2, executable: false }));
    s.advance(DEFAULT_WATCH_INTERVAL_MS);
    // Reject only the second proposal.
    const second = await s.proposalOf(settled.id);
    s.approval.readImpl = (ref) =>
      Promise.resolve(
        ok(
          ref.kind === 'squads' && ref.proposal === second.proposalRef
            ? { status: 'rejected' as const, approvals: 0, threshold: 2, executable: false }
            : active(),
        ),
      );
    await s.coordinator.watchProposals(10);

    await s.coordinator.restoreReservations();

    expect(s.handler.restoreInFlight).toHaveBeenCalledWith(['signed-prop-1']);
  });
});

describe('approvalLoop (the worker)', () => {
  it('ticks watchProposals until stopped, and a failed tick does not stop it', async () => {
    let running = true;
    const watchProposals = vi
      .fn<(limit: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error('tick failed'))
      .mockResolvedValue(undefined);
    const sleeps: number[] = [];
    const error = vi.fn();
    await approvalLoop({
      coordinator: { watchProposals },
      isRunning: () => running,
      limit: 20,
      logger: { error } as never,
      sleep: (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) running = false;
        return Promise.resolve();
      },
    });

    expect(watchProposals).toHaveBeenCalledTimes(3);
    expect(watchProposals).toHaveBeenCalledWith(20);
    expect(sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toBe('worker approval tick failed');
  });
});

describe('per-chain approval deadline', () => {
  it("uses the chain's own deadline when one is configured, else the default", async () => {
    const start = new Date('2024-01-01T00:00:00.000Z');
    const cases: [Map<'solana', number>, number][] = [
      [new Map<'solana', number>([['solana', 2 * HOUR]]), 2 * HOUR],
      [new Map<'solana', number>(), DEFAULT_APPROVAL_DEADLINE_MS],
    ];
    for (const [byChain, expected] of cases) {
      const store = new InMemoryDispatchStore(() => start);
      const coordinator = new Coordinator({
        store,
        chainHandlers: new Map([['solana', new MultisigHandler()]]),
        senderAddresses: new Map([['solana', 'vault']]),
        abandonmentTimeoutMs: new Map([['solana', 600_000]]),
        approvalDeadlineMsByChain: byChain,
        now: () => start,
        logger: pino({ level: 'silent' }),
      });
      const d = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'k',
        items: [item(1)],
        retryPolicy: false,
      });
      await coordinator.processQueuedDispatches(10);
      const [proposal] = await store.listProposalsForDispatch(d.id);
      expect(proposal?.deadlineAt.getTime()).toBe(start.getTime() + expected);
    }
  });
});

describe('chains without the capability', () => {
  it('watchProposals does nothing', async () => {
    const store = new InMemoryDispatchStore();
    const plain = new MultisigHandler();
    const handler = Object.assign(Object.create(plain) as MultisigHandler, { approval: undefined });
    const coordinator = new Coordinator({
      store,
      chainHandlers: new Map([['solana', handler]]),
      senderAddresses: new Map([['solana', 'sender']]),
      abandonmentTimeoutMs: new Map([['solana', 600_000]]),
      logger: pino({ level: 'silent' }),
    });
    const listDue = vi.spyOn(store, 'listProposalsDue');
    await coordinator.watchProposals(10);
    expect(listDue).not.toHaveBeenCalled();
  });
});

describe('closing finished proposals (#75)', () => {
  const closeFailed: DispatchError = { code: 'RPC_UNAVAILABLE', message: 'node down' };
  const executed = (hash = 'human-exec'): ProposalSnapshot => ({
    status: 'executed',
    approvals: 2,
    threshold: 2,
    executedHash: hash,
    executable: false,
  });

  it('closes a proposal someone else executed, once, after the Calls are CONFIRMED', async () => {
    const s = setup();
    const d = await s.openProposal([item(1), item(2)]);
    const closed: string[] = [];
    s.approval.closeImpl = async (proposal) => {
      closed.push(`${proposal.id}:${(await s.statuses(d.id)).join(',')}`);
      return ok(undefined);
    };
    s.approval.readImpl = () => Promise.resolve(ok(executed()));

    await s.coordinator.watchProposals(10);

    expect(closed).toEqual([`${(await s.proposalOf(d.id)).id}:CONFIRMED,CONFIRMED`]);
    s.advance(HOUR);
    await s.coordinator.watchProposals(10);
    expect(closed).toHaveLength(1);
  });

  for (const status of ['rejected', 'cancelled', 'stale'] as const) {
    it(`closes a ${status} proposal after failing its Calls`, async () => {
      const s = setup();
      const d = await s.openProposal([item(1)]);
      const closeImpl = vi.fn(() => Promise.resolve(ok(undefined)));
      s.approval.closeImpl = closeImpl;
      s.approval.readImpl = () =>
        Promise.resolve(ok({ status, approvals: 0, threshold: 2, executable: false }));

      await s.coordinator.watchProposals(10);

      expect(closeImpl).toHaveBeenCalledTimes(1);
      expect(await s.statuses(d.id)).toEqual(['FAILED']);
    });
  }

  it('closes the proposal once the engine’s own execute is CONFIRMED', async () => {
    const s = setup();
    const d = await s.openProposal([item(1), item(2)]);
    const closeImpl = vi.fn(() => Promise.resolve(ok(undefined)));
    s.approval.closeImpl = closeImpl;
    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    await s.coordinator.watchProposals(10);
    expect(closeImpl).not.toHaveBeenCalled(); // an approved proposal is not closable yet

    s.handler.statuses.set('hash-of-signed-1', 'CONFIRMED');
    await s.coordinator.pollPendingTransactions(10);
    expect(await s.statuses(d.id)).toEqual(['CONFIRMED', 'CONFIRMED']);
    s.advance(DEFAULT_WATCH_INTERVAL_MS);
    await s.coordinator.watchProposals(10);

    expect(closeImpl).toHaveBeenCalledTimes(1);
    expect((await s.proposalOf(d.id)).phase).toBe('resolved');
  });

  it('never closes a timed-out proposal (that is #88)', async () => {
    const s = setup();
    const d = await s.openProposal([item(1)]);
    const closeImpl = vi.fn(() => Promise.resolve(ok(undefined)));
    s.approval.closeImpl = closeImpl;
    s.advance(DEFAULT_APPROVAL_DEADLINE_MS);
    await s.coordinator.watchProposals(10);
    expect(await s.statuses(d.id)).toEqual(['ABANDONED']);
    expect(closeImpl).not.toHaveBeenCalled();
  });

  it('a failed close, an error result or a throw never changes what the Calls reported', async () => {
    for (const closeImpl of [
      () => Promise.resolve(err(closeFailed)),
      () => Promise.reject(new Error('boom')),
    ]) {
      const s = setup();
      const d = await s.openProposal([item(1), item(2)]);
      s.approval.closeImpl = closeImpl;
      s.approval.readImpl = () => Promise.resolve(ok(executed()));

      await s.coordinator.watchProposals(10);

      expect(await s.statuses(d.id)).toEqual(['CONFIRMED', 'CONFIRMED']);
      expect((await s.proposalOf(d.id)).phase).toBe('resolved');
    }
  });

  it('tries a failed close again on a later tick, stops once it works, and gives up after five tries', async () => {
    const s = setup();
    await s.openProposal([item(1)]);
    let attempts = 0;
    s.approval.closeImpl = () => {
      attempts += 1;
      return Promise.resolve(attempts < 3 ? err(closeFailed) : ok(undefined));
    };
    s.approval.readImpl = () => Promise.resolve(ok(executed()));
    await s.coordinator.watchProposals(10);
    expect(attempts).toBe(1);

    await s.coordinator.watchProposals(10); // too soon
    expect(attempts).toBe(1);
    s.advance(60_000);
    await s.coordinator.watchProposals(10);
    expect(attempts).toBe(2);
    s.advance(120_000);
    await s.coordinator.watchProposals(10);
    expect(attempts).toBe(3);
    s.advance(HOUR);
    await s.coordinator.watchProposals(10);
    expect(attempts).toBe(3); // done

    const never = setup();
    await never.openProposal([item(1)]);
    const always = vi.fn(() => Promise.resolve(err(closeFailed)));
    never.approval.closeImpl = always;
    never.approval.readImpl = () => Promise.resolve(ok(executed()));
    await never.coordinator.watchProposals(10);
    for (let i = 0; i < 10; i++) {
      never.advance(HOUR);
      await never.coordinator.watchProposals(10);
    }
    expect(always).toHaveBeenCalledTimes(5);
  });

  it('does not retry a multisig that cannot reclaim rent', async () => {
    const s = setup();
    await s.openProposal([item(1)]);
    const noCollector: DispatchError = {
      code: 'CHAIN_REJECTED',
      message: 'no rent collector',
      chainDetail: { reason: 'RENT_RECLAMATION_DISABLED' },
    };
    const closeImpl = vi.fn(() => Promise.resolve(err(noCollector)));
    s.approval.closeImpl = closeImpl;
    s.approval.readImpl = () => Promise.resolve(ok(executed()));
    await s.coordinator.watchProposals(10);
    s.advance(HOUR);
    await s.coordinator.watchProposals(10);
    expect(closeImpl).toHaveBeenCalledTimes(1);
  });

  it('a chain handler with no closeProposal simply is not asked', async () => {
    const s = setup();
    const d = await s.openProposal([item(1)]);
    (s.approval as { closeProposal?: unknown }).closeProposal = undefined;
    s.approval.readImpl = () => Promise.resolve(ok(executed()));
    await s.coordinator.watchProposals(10);
    expect(await s.statuses(d.id)).toEqual(['CONFIRMED']);
  });

  it('a failed execute that someone else then completed is CONFIRMED, never FAILED, and is closed', async () => {
    const s = setup();
    const d = await s.openProposal([item(1), item(2)]);
    const closeImpl = vi.fn(() => Promise.resolve(ok(undefined)));
    s.approval.closeImpl = closeImpl;
    s.approval.readImpl = () => Promise.resolve(ok(approved()));
    await s.coordinator.watchProposals(10);
    s.handler.statuses.set('hash-of-signed-1', 'FAILED');
    const markFailed = vi.spyOn(s.store, 'markFailed');
    // Between the failed attempt and the check, an Approver with Execute ran it.
    s.approval.readImpl = () => Promise.resolve(ok(executed('human-exec')));

    await s.coordinator.pollPendingTransactions(10);

    expect(markFailed).not.toHaveBeenCalled();
    expect((await s.rows(d.id)).map((t) => [t.status, t.hash])).toEqual([
      ['CONFIRMED', 'human-exec'],
      ['CONFIRMED', 'human-exec'],
    ]);
    expect(closeImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Coordinator.watchProposals: a noted proposal never wedges the Sender', () => {
  const expired: DispatchError = {
    code: 'RPC_UNAVAILABLE',
    message: 'blockhash expired',
    chainDetail: { reason: 'BLOCKHASH_EXPIRED' },
  };
  const rejected: DispatchError = { code: 'CHAIN_REJECTED', message: 'the service said no' };

  /** A Dispatch whose first send did not go through, so its proposal is `noted`. */
  const notedProposal = async (s: ReturnType<typeof setup>) => {
    s.approval.submitImpl = () => Promise.resolve(err(rpcDown));
    const d = await s.dispatch([item(1)]);
    await s.coordinator.processQueuedDispatches(10);
    expect((await s.proposalOf(d.id)).phase).toBe('noted');
    return d;
  };

  it('moves a proposal that already landed to open without sending again', async () => {
    const s = setup();
    const d = await notedProposal(s);
    s.approval.readImpl = () => Promise.resolve(ok(active()));
    s.approval.submitImpl = () => Promise.resolve(ok(undefined));
    const sends = s.approval.submitted.length;
    s.advance(10 * 60 * 1000);

    await s.coordinator.watchProposals(10);

    expect((await s.proposalOf(d.id)).phase).toBe('open');
    expect(s.approval.submitted).toHaveLength(sends);
    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
  });

  it.each(['approved', 'rejected', 'cancelled', 'executed', 'stale'] as const)(
    'treats a %s proposal as existing: open for watchOpen, never re-sent',
    async (status) => {
      const s = setup();
      const d = await notedProposal(s);
      s.approval.readImpl = () =>
        Promise.resolve(ok({ status, approvals: 2, threshold: 2, executable: false }));
      s.approval.submitImpl = () => Promise.resolve(err(rejected));
      s.advance(10 * 60 * 1000);

      await s.coordinator.watchProposals(1);

      expect((await s.proposalOf(d.id)).phase).not.toBe('noted');
      expect(s.approval.submitted).toHaveLength(0);
      expect(s.approval.events.filter((e) => e.startsWith('submit'))).toHaveLength(1); // only the first, failed send
    },
  );

  it('backs off when the existence check cannot be read, sending nothing', async () => {
    const s = setup();
    const d = await notedProposal(s);
    s.approval.readImpl = () => Promise.resolve(err(rpcDown));
    const events = s.approval.events.length;
    s.advance(10 * 60 * 1000);

    await s.coordinator.watchProposals(10);

    expect(await s.proposalOf(d.id)).toMatchObject({ phase: 'noted', checkFailures: 1 });
    expect(s.approval.events).toHaveLength(events);
  });

  it('re-signs an expired blockhash, writing the new bytes down before sending them', async () => {
    const s = setup();
    const d = await notedProposal(s);
    s.approval.signImpl = () =>
      Promise.resolve(ok({ signedBytes: 'resigned-1', hash: 'rehash-1' }));
    const seenWhenSending: string[] = [];
    s.approval.submitImpl = async (signed) => {
      const stored = await s.proposalOf(d.id);
      seenWhenSending.push(`${signed.signedBytes}|stored:${stored.proposeSignedBytes}`);
      return signed.signedBytes === 'signed-prop-1' ? err(expired) : ok(undefined);
    };
    s.advance(10 * 60 * 1000);

    await s.coordinator.watchProposals(10);

    expect(await s.proposalOf(d.id)).toMatchObject({
      phase: 'open',
      proposeSignedBytes: 'resigned-1',
      proposeHash: 'rehash-1',
    });
    // The re-signed bytes were already stored at the moment they were sent.
    expect(seenWhenSending).toEqual([
      'signed-prop-1|stored:signed-prop-1',
      'resigned-1|stored:resigned-1',
    ]);
    // Rebuilt from the stored proposal.
    expect(s.approval.signed.at(-1)).toMatchObject({
      proposalRef: 'prop-1',
      payload: 'payload-prop-1',
      sequence: 1,
    });
    expect(s.approval.events.slice(-3)).toEqual([
      'submit-failed:hash-prop-1',
      'sign:prop-1',
      'submit:rehash-1',
    ]);
    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
  });

  it('bounds the re-signs: a proposal that keeps expiring backs off and is abandoned at the deadline', async () => {
    const s = setup();
    const d = await notedProposal(s);
    s.approval.submitImpl = () => Promise.resolve(err(expired));
    for (let i = 0; i < 12; i += 1) {
      s.advance(10 * 60 * 1000);
      await s.coordinator.watchProposals(10);
    }
    // 5 re-signs at most (plus the original signing), however many passes.
    expect(s.approval.signed.length).toBeLessThanOrEqual(1 + 5);
    expect((await s.proposalOf(d.id)).phase).toBe('noted');
    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
    s.advance(DEFAULT_APPROVAL_DEADLINE_MS);
    await s.coordinator.watchProposals(10);
    expect(await s.statuses(d.id)).toEqual(['ABANDONED']);
  });

  it('backs off, keeping the old bytes, when re-signing finds the Signer unreachable', async () => {
    const s = setup();
    const d = await notedProposal(s);
    s.approval.submitImpl = () => Promise.resolve(err(expired));
    s.approval.signImpl = () => Promise.resolve(err(signerDown));
    s.advance(10 * 60 * 1000);

    await s.coordinator.watchProposals(10);

    expect(await s.proposalOf(d.id)).toMatchObject({
      phase: 'noted',
      proposeSignedBytes: 'signed-prop-1',
      checkFailures: 1,
    });
    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
  });

  it('fails the Calls when the chain refuses the send and the proposal does not exist', async () => {
    const s = setup();
    const d = await notedProposal(s);
    s.approval.submitImpl = () => Promise.resolve(err(rejected));
    s.advance(10 * 60 * 1000);

    await s.coordinator.watchProposals(10);

    expect((await s.rows(d.id)).map((t) => [t.status, t.error?.code])).toEqual([
      ['FAILED', 'CHAIN_REJECTED'],
    ]);
    expect((await s.proposalOf(d.id)).phase).toBe('resolved');
  });

  it('fails the Calls when re-signing is refused by the Signer', async () => {
    const s = setup();
    const d = await notedProposal(s);
    s.approval.submitImpl = () => Promise.resolve(err(expired));
    s.approval.signImpl = () => Promise.resolve(err(signerRefused));
    s.advance(10 * 60 * 1000);

    await s.coordinator.watchProposals(10);

    expect((await s.rows(d.id)).map((t) => [t.status, t.error?.code])).toEqual([
      ['FAILED', 'SIGNER_REFUSED'],
    ]);
    expect((await s.proposalOf(d.id)).phase).toBe('resolved');
  });

  it('does NOT fail the Calls when the chain would refuse a re-send but the proposal exists', async () => {
    const s = setup();
    const d = await notedProposal(s);
    s.approval.readImpl = () => Promise.resolve(ok(active()));
    s.approval.submitImpl = () => Promise.resolve(err(rejected));
    s.advance(10 * 60 * 1000);

    await s.coordinator.watchProposals(10);

    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
    expect((await s.proposalOf(d.id)).phase).toBe('open');
  });

  it('does not treat a transient send error as a refusal', async () => {
    const s = setup();
    const d = await notedProposal(s);
    s.approval.submitImpl = () => Promise.resolve(err(signerDown));
    s.advance(10 * 60 * 1000);

    await s.coordinator.watchProposals(10);

    expect(await s.statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
    expect((await s.proposalOf(d.id)).phase).toBe('noted');
  });

  it('a refused noted proposal no longer blocks the next Dispatch', async () => {
    const s = setup();
    const a = await notedProposal(s);
    const b = await s.dispatch([item(2)]);
    await s.coordinator.processQueuedDispatches(10);
    expect(await s.statuses(b.id)).toEqual(['UNPROPOSED']); // held behind the noted one

    s.approval.submitImpl = (signed) =>
      Promise.resolve(signed.hash === 'hash-prop-1' ? err(rejected) : ok(undefined));
    s.advance(10 * 60 * 1000);
    await s.coordinator.watchProposals(10);
    expect(await s.statuses(a.id)).toEqual(['FAILED']);

    await s.coordinator.processQueuedDispatches(10);
    expect(await s.statuses(b.id)).toEqual(['AWAITING_APPROVAL']);
  });

  it('a noted proposal that landed no longer blocks the next Dispatch once it is open', async () => {
    const s = setup();
    const a = await notedProposal(s);
    const b = await s.dispatch([item(2)]);
    s.approval.readImpl = () => Promise.resolve(ok(active()));
    s.approval.submitImpl = () => Promise.resolve(ok(undefined));
    s.advance(10 * 60 * 1000);
    await s.coordinator.watchProposals(10);
    expect((await s.proposalOf(a.id)).phase).toBe('open');

    await s.coordinator.processQueuedDispatches(10);
    expect(await s.statuses(b.id)).toEqual(['AWAITING_APPROVAL']);
  });

  it('continues from the persisted bytes after a restart in the middle', async () => {
    const s = setup();
    const d = await notedProposal(s);
    // First pass: re-signed and persisted, but the send is ambiguous.
    s.approval.submitImpl = (signed) =>
      Promise.resolve(signed.signedBytes === 'signed-prop-1' ? err(expired) : err(rpcDown));
    s.approval.signImpl = () =>
      Promise.resolve(ok({ signedBytes: 'resigned-1', hash: 'rehash-1' }));
    s.advance(10 * 60 * 1000);
    await s.coordinator.watchProposals(10);
    expect(await s.proposalOf(d.id)).toMatchObject({
      phase: 'noted',
      proposeSignedBytes: 'resigned-1',
    });

    // Restart: a fresh Coordinator sends exactly the stored bytes.
    const restarted = s.makeCoordinator();
    s.approval.submitImpl = () => Promise.resolve(ok(undefined));
    s.approval.submitted.length = 0;
    s.advance(10 * 60 * 1000);
    await restarted.watchProposals(10);

    expect(s.approval.submitted).toEqual([{ signedBytes: 'resigned-1', hash: 'rehash-1' }]);
    expect((await s.proposalOf(d.id)).phase).toBe('open');
  });

  it('abandons with a message saying the proposal could not be sent', async () => {
    const s = setup();
    const d = await notedProposal(s);
    s.advance(DEFAULT_APPROVAL_DEADLINE_MS);

    await s.coordinator.watchProposals(10);

    const [row] = await s.rows(d.id);
    expect(row?.error?.code).toBe('APPROVAL_TIMEOUT');
    expect(row?.error?.message).toContain('could not be sent');
  });
});
