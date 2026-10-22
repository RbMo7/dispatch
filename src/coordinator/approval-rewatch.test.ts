import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

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
import type { ChainProposalRef } from '../domain/proposal.js';
import { err, ok, type Result } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import {
  DEFAULT_APPROVAL_DEADLINE_MS,
  DEFAULT_APPROVAL_REWATCH_WINDOW_MS,
  DEFAULT_LATE_APPROVAL_LOG_INTERVAL_MS,
  DEFAULT_REWATCH_FIRST_PERIOD_MS,
  DEFAULT_REWATCH_LATER_INTERVAL_MS,
  DEFAULT_WATCH_INTERVAL_MS,
} from './approval-flow.js';
import { Coordinator } from './coordinator.js';

/**
 * #88 / ADR-0053: a Proposal that timed out is still read, for a bounded
 * window, because someone else can execute or reject it. Driven through the
 * Coordinator with a scriptable approval capability and the in-memory store.
 */
const call = (n: number): SolanaCall => ({ programId: 'prog', accounts: [], data: `call-${n}` });
const item = (n: number): DispatchItem<'solana'> => ({ call: call(n), payment: null });

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const rpcDown: DispatchError = { code: 'RPC_UNAVAILABLE', message: 'node down' };

const snapshot = (
  status: ProposalSnapshot['status'],
  extra: Partial<ProposalSnapshot> = {},
): ProposalSnapshot => ({
  status,
  approvals: status === 'approved' ? 2 : 1,
  threshold: 2,
  executable: status === 'approved',
  ...extra,
});

class MultisigHandler implements ChainHandler<'solana'> {
  readonly chain = 'solana';
  readonly approval = new FakeApproval<'solana'>();
  signed = 0;
  statuses = new Map<string, ChainStatus>();

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
    (_p: PreparedTransaction, _s: string): Promise<Result<SignedTransaction, DispatchError>> =>
      Promise.resolve(ok(`signed-${++this.signed}`)),
  );
  transactionHash = vi.fn((signed: SignedTransaction): Result<string, DispatchError> =>
    ok(`hash-of-${signed}`),
  );
  broadcast = vi.fn((signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>> =>
    Promise.resolve(ok({ hash: `hash-of-${signed}` })),
  );
  getStatus = vi.fn((hash: string): Promise<Result<ChainStatus, DispatchError>> =>
    Promise.resolve(ok(this.statuses.get(hash) ?? 'PENDING')),
  );
  getBalance = vi.fn((_a: string, asset: string): Promise<Result<Balance, DispatchError>> =>
    Promise.resolve(ok({ asset, amount: '1000000' })),
  );
  prepareReplacement = vi.fn((): Promise<Result<PreparedTransaction, DispatchError>> =>
    Promise.resolve(ok({ callIndex: 0, unsignedTransaction: 'replacement' })),
  );
  restoreInFlight = vi.fn((_signed: string[]): Promise<void> => Promise.resolve());
}

type LogLine = { msg: string; level: number; [key: string]: unknown };

function setup(options: { windowMs?: number; limit?: number } = {}) {
  let currentTime = new Date('2024-01-01T00:00:00.000Z');
  const clock = () => currentTime;
  const advance = (ms: number) => {
    currentTime = new Date(currentTime.getTime() + ms);
  };
  const lines: LogLine[] = [];
  const logger = pino(
    { level: 'info' },
    { write: (s: string) => lines.push(JSON.parse(s) as LogLine) },
  );
  const store = new InMemoryDispatchStore(clock);
  const handler = new MultisigHandler();
  if (options.limit !== undefined) handler.approval.openProposalLimit = options.limit;
  const makeCoordinator = () =>
    new Coordinator({
      store,
      chainHandlers: new Map([['solana', handler]]),
      senderAddresses: new Map([['solana', 'vault']]),
      abandonmentTimeoutMs: new Map([['solana', 600_000]]),
      ...(options.windowMs === undefined ? {} : { approvalRewatchWindowMs: options.windowMs }),
      now: clock,
      sleep: () => Promise.resolve(),
      logger,
    });
  const coordinator = makeCoordinator();

  let keys = 0;
  const dispatch = (items: DispatchItem<'solana'>[]) =>
    store.createDispatch({
      chain: 'solana',
      idempotencyKey: `key-${keys++}`,
      items,
      retryPolicy: false,
    });
  const proposalOf = async (dispatchId: string) => {
    const [proposal] = await store.listProposalsForDispatch(dispatchId);
    if (!proposal) throw new Error('no proposal');
    return proposal;
  };
  const rows = async (dispatchId: string) =>
    (await store.listTransactions(dispatchId))
      .filter((t) => !['REPLACED', 'DROPPED'].includes(t.status))
      .sort((a, b) => a.callIndex - b.callIndex);
  const statuses = async (dispatchId: string) => (await rows(dispatchId)).map((t) => t.status);
  const logged = (msg: string) => lines.filter((l) => l.msg.startsWith(msg));

  /** Proposes a Dispatch, opens it, and lets its deadline pass: the Proposal is `timed_out`. */
  const timedOut = async (items = [item(1), item(2)]) => {
    const d = await dispatch(items);
    await coordinator.processQueuedDispatches(10);
    await coordinator.watchProposals(10);
    advance(DEFAULT_APPROVAL_DEADLINE_MS);
    await coordinator.watchProposals(10);
    expect((await proposalOf(d.id)).phase).toBe('timed_out');
    expect(await statuses(d.id)).toEqual(items.map(() => 'ABANDONED'));
    return d;
  };

  return {
    store,
    handler,
    approval: handler.approval,
    coordinator,
    makeCoordinator,
    advance,
    now: clock,
    dispatch,
    proposalOf,
    rows,
    statuses,
    logged,
    lines,
    timedOut,
  };
}

describe('re-watching a timed-out Proposal (#88, ADR-0053)', () => {
  describe('executed by someone else', () => {
    it('confirms the Calls, links the hash, resolves the Proposal and logs late_execution_detected', async () => {
      const { coordinator, approval, handler, timedOut, advance, rows, proposalOf, logged } =
        setup();
      const d = await timedOut();
      approval.readImpl = () =>
        Promise.resolve(ok(snapshot('executed', { executedHash: 'human-exec' })));

      advance(DEFAULT_WATCH_INTERVAL_MS);
      await coordinator.watchProposals(10);

      expect((await rows(d.id)).map((t) => [t.status, t.hash, t.error])).toEqual([
        ['CONFIRMED', 'human-exec', null],
        ['CONFIRMED', 'human-exec', null],
      ]);
      expect((await proposalOf(d.id)).phase).toBe('resolved');
      expect(handler.sign).not.toHaveBeenCalled();
      const [line] = logged('late_execution_detected');
      expect(line).toMatchObject({
        proposalId: (await proposalOf(d.id)).id,
        dispatchId: d.id,
        executedHash: 'human-exec',
      });
    });

    it('closes the finished Proposal when the chain can, and records that it is closed', async () => {
      const { coordinator, approval, timedOut, advance, proposalOf } = setup();
      const d = await timedOut();
      const closed: string[] = [];
      approval.closeImpl = (p) => {
        closed.push(p.id);
        return Promise.resolve(ok(undefined));
      };
      approval.readImpl = () =>
        Promise.resolve(ok(snapshot('executed', { executedHash: 'human-exec' })));

      advance(DEFAULT_WATCH_INTERVAL_MS);
      await coordinator.watchProposals(10);

      const proposal = await proposalOf(d.id);
      expect(closed).toEqual([proposal.id]);
      expect(proposal.closeState).toBe('closed');
    });
  });

  describe('rejected late', () => {
    for (const status of ['rejected', 'cancelled', 'stale'] as const) {
      it(`fails the Calls with APPROVAL_REJECTED when the proposal turns out ${status}, and closes it`, async () => {
        const { coordinator, approval, timedOut, advance, rows, proposalOf, handler } = setup();
        const d = await timedOut();
        const closed: string[] = [];
        approval.closeImpl = (p) => {
          closed.push(p.id);
          return Promise.resolve(ok(undefined));
        };
        approval.readImpl = () => Promise.resolve(ok(snapshot(status)));

        advance(DEFAULT_WATCH_INTERVAL_MS);
        await coordinator.watchProposals(10);

        const failed = await rows(d.id);
        expect(failed.map((t) => t.status)).toEqual(['FAILED', 'FAILED']);
        expect(failed.map((t) => t.error?.code)).toEqual([
          'APPROVAL_REJECTED',
          'APPROVAL_REJECTED',
        ]);
        expect(failed.every((t) => t.hash === null)).toBe(true);
        expect((await proposalOf(d.id)).phase).toBe('resolved');
        expect(closed).toHaveLength(1);
        expect(handler.sign).not.toHaveBeenCalled();
      });
    }
  });

  describe('approved but not executed', () => {
    it('stays ABANDONED, reads approved_after_deadline, and is never executed', async () => {
      const { coordinator, approval, handler, timedOut, advance, rows, proposalOf } = setup();
      const d = await timedOut();
      const prepare = vi.spyOn(approval, 'prepareExecution');
      approval.readImpl = () => Promise.resolve(ok(snapshot('approved')));

      for (let i = 0; i < 5; i++) {
        advance(DEFAULT_WATCH_INTERVAL_MS);
        await coordinator.watchProposals(10);
      }

      expect((await rows(d.id)).map((t) => [t.status, t.error?.code])).toEqual([
        ['ABANDONED', 'APPROVAL_TIMEOUT'],
        ['ABANDONED', 'APPROVAL_TIMEOUT'],
      ]);
      expect(await proposalOf(d.id)).toMatchObject({
        phase: 'timed_out',
        approvalState: 'approved_after_deadline',
        approvals: 2,
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(handler.sign).not.toHaveBeenCalled();
      expect(handler.broadcast).not.toHaveBeenCalled();
    });

    it('logs it loudly, but at a bounded interval and not on every read', async () => {
      const { coordinator, approval, timedOut, advance, logged, lines } = setup();
      await timedOut();
      approval.readImpl = () => Promise.resolve(ok(snapshot('approved')));

      for (let i = 0; i < 20; i++) {
        advance(DEFAULT_WATCH_INTERVAL_MS);
        await coordinator.watchProposals(10);
      }
      expect(logged('approved_after_deadline')).toHaveLength(1);
      expect(logged('approved_after_deadline')[0]?.level).toBe(50); // error: loud

      advance(DEFAULT_LATE_APPROVAL_LOG_INTERVAL_MS);
      await coordinator.watchProposals(10);
      expect(logged('approved_after_deadline')).toHaveLength(2);
      expect(lines.filter((l) => l.msg.startsWith('late_execution_detected'))).toHaveLength(0);
    });

    it('still settles it CONFIRMED if someone executes it afterwards', async () => {
      const { coordinator, approval, timedOut, advance, statuses } = setup();
      const d = await timedOut();
      approval.readImpl = () => Promise.resolve(ok(snapshot('approved')));
      advance(DEFAULT_WATCH_INTERVAL_MS);
      await coordinator.watchProposals(10);
      expect(await statuses(d.id)).toEqual(['ABANDONED', 'ABANDONED']);

      approval.readImpl = () => Promise.resolve(ok(snapshot('executed', { executedHash: 'late' })));
      advance(DEFAULT_WATCH_INTERVAL_MS);
      await coordinator.watchProposals(10);
      expect(await statuses(d.id)).toEqual(['CONFIRMED', 'CONFIRMED']);
    });
  });

  describe('still undecided, unreadable, unknown', () => {
    it('keeps waiting while the proposal is active', async () => {
      const { coordinator, approval, timedOut, advance, statuses, proposalOf } = setup();
      const d = await timedOut();
      approval.readImpl = () => Promise.resolve(ok(snapshot('active', { approvals: 1 })));

      advance(DEFAULT_WATCH_INTERVAL_MS);
      await coordinator.watchProposals(10);

      expect(await statuses(d.id)).toEqual(['ABANDONED', 'ABANDONED']);
      expect(await proposalOf(d.id)).toMatchObject({
        phase: 'timed_out',
        approvalState: 'awaiting',
        approvals: 1,
      });
    });

    it('backs off, per proposal and longer each time, when it cannot be read, and recovers', async () => {
      const { coordinator, approval, timedOut, advance, proposalOf, now, statuses } = setup();
      const d = await timedOut();
      approval.readImpl = () => Promise.resolve(err(rpcDown));
      const gaps: number[] = [];

      for (let failures = 1; failures <= 3; failures++) {
        advance(DAY / 24);
        await coordinator.watchProposals(10);
        const p = await proposalOf(d.id);
        expect(p.checkFailures).toBe(failures);
        gaps.push(p.nextCheckAt.getTime() - now().getTime());
      }
      expect(gaps[1]).toBeGreaterThan(gaps[0] as number);
      expect(gaps[2]).toBeGreaterThan(gaps[1] as number);
      expect(await statuses(d.id)).toEqual(['ABANDONED', 'ABANDONED']);

      approval.readImpl = () => Promise.resolve(ok(snapshot('active')));
      advance(HOUR);
      await coordinator.watchProposals(10);
      expect((await proposalOf(d.id)).checkFailures).toBe(0);
    });

    it('treats an unknown state as unreadable: nothing is settled, and it backs off', async () => {
      const { coordinator, approval, timedOut, advance, proposalOf, statuses } = setup();
      const d = await timedOut();
      approval.readImpl = () => Promise.resolve(ok(snapshot('unknown')));

      advance(HOUR);
      await coordinator.watchProposals(10);

      expect(await statuses(d.id)).toEqual(['ABANDONED', 'ABANDONED']);
      expect(await proposalOf(d.id)).toMatchObject({ phase: 'timed_out', checkFailures: 1 });
    });

    it('one proposal failing to read does not stop the next', async () => {
      const { coordinator, approval, timedOut, advance, statuses } = setup();
      const a = await timedOut([item(1)]);
      const b = await timedOut([item(2)]);
      approval.readImpl = vi
        .fn<typeof approval.readImpl>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(ok(snapshot('rejected')));

      advance(HOUR);
      await coordinator.watchProposals(10);

      expect([...(await statuses(a.id)), ...(await statuses(b.id))].sort()).toEqual([
        'ABANDONED',
        'FAILED',
      ]);
    });
  });

  describe('cadence', () => {
    it('reads at the chain cadence on the first day, then hourly', async () => {
      const { coordinator, approval, timedOut, advance, proposalOf, now } = setup();
      const d = await timedOut();
      approval.readImpl = () => Promise.resolve(ok(snapshot('active')));
      const reads = vi.fn(approval.readImpl);
      approval.readImpl = reads;

      // The first day: the next read is one cadence away, however often it is asked.
      advance(DEFAULT_WATCH_INTERVAL_MS);
      await coordinator.watchProposals(10);
      expect(reads).toHaveBeenCalledTimes(1);
      expect((await proposalOf(d.id)).nextCheckAt.getTime() - now().getTime()).toBe(
        DEFAULT_WATCH_INTERVAL_MS,
      );
      await coordinator.watchProposals(10); // not due yet
      expect(reads).toHaveBeenCalledTimes(1);

      // Past the first day: hourly.
      advance(DEFAULT_REWATCH_FIRST_PERIOD_MS);
      await coordinator.watchProposals(10);
      expect(reads).toHaveBeenCalledTimes(2);
      expect((await proposalOf(d.id)).nextCheckAt.getTime() - now().getTime()).toBe(
        DEFAULT_REWATCH_LATER_INTERVAL_MS,
      );
      advance(DEFAULT_REWATCH_LATER_INTERVAL_MS - 1);
      await coordinator.watchProposals(10);
      expect(reads).toHaveBeenCalledTimes(2);
      advance(1);
      await coordinator.watchProposals(10);
      expect(reads).toHaveBeenCalledTimes(3);
    });

    it('reads a Proposal that has just timed out again after one cadence, not an hour', async () => {
      const { approval, timedOut, proposalOf, now } = setup();
      const d = await timedOut();
      expect((await proposalOf(d.id)).nextCheckAt.getTime() - now().getTime()).toBe(
        approval.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS,
      );
    });
  });

  describe('the window', () => {
    it('ends: logs rewatch_window_ended once, resolves the Proposal and leaves the Calls ABANDONED', async () => {
      const { coordinator, approval, timedOut, advance, statuses, proposalOf, logged } = setup();
      const d = await timedOut();
      const reads = vi.fn(approval.readImpl);
      approval.readImpl = reads;

      advance(DEFAULT_APPROVAL_REWATCH_WINDOW_MS);
      await coordinator.watchProposals(10);
      await coordinator.watchProposals(10);
      advance(DAY);
      await coordinator.watchProposals(10);

      expect(logged('rewatch_window_ended')).toHaveLength(1);
      expect(logged('rewatch_window_ended')[0]).toMatchObject({
        proposalId: (await proposalOf(d.id)).id,
      });
      expect(await statuses(d.id)).toEqual(['ABANDONED', 'ABANDONED']);
      expect(await proposalOf(d.id)).toMatchObject({ phase: 'resolved' });
      expect(reads).not.toHaveBeenCalled();
    });

    it('is configurable, and is still being watched one tick before it ends', async () => {
      const { coordinator, approval, timedOut, advance, proposalOf } = setup({ windowMs: 2 * DAY });
      const d = await timedOut();
      approval.readImpl = () => Promise.resolve(ok(snapshot('active')));

      advance(2 * DAY - 1);
      await coordinator.watchProposals(10);
      expect((await proposalOf(d.id)).phase).toBe('timed_out');

      advance(DEFAULT_REWATCH_LATER_INTERVAL_MS);
      await coordinator.watchProposals(10);
      expect((await proposalOf(d.id)).phase).toBe('resolved');
    });

    it('counts from when the Proposal timed out, not from when it was created', async () => {
      const { coordinator, timedOut, advance, proposalOf } = setup({ windowMs: 2 * DAY });
      const d = await timedOut();
      const proposal = await proposalOf(d.id);
      expect(proposal.timedOutAt).not.toBeNull();
      // Created 3 days ago (the deadline), timed out just now: still inside a 2-day window.
      advance(DAY);
      await coordinator.watchProposals(10);
      expect((await proposalOf(d.id)).phase).toBe('timed_out');
    });
  });

  describe('restart', () => {
    it('a fresh Coordinator carries on from the persisted timed_out_at: it detects a late execution', async () => {
      const { makeCoordinator, approval, timedOut, advance, statuses } = setup();
      const d = await timedOut();
      const restarted = makeCoordinator();
      approval.readImpl = () =>
        Promise.resolve(ok(snapshot('executed', { executedHash: 'human-exec' })));

      advance(DEFAULT_WATCH_INTERVAL_MS);
      await restarted.watchProposals(10);

      expect(await statuses(d.id)).toEqual(['CONFIRMED', 'CONFIRMED']);
    });

    it('a fresh Coordinator keeps the window: it ends exactly when the first one would have', async () => {
      const { makeCoordinator, timedOut, advance, proposalOf, logged } = setup({ windowMs: DAY });
      const d = await timedOut();
      advance(DAY - HOUR);
      const restarted = makeCoordinator();
      await restarted.watchProposals(10);
      expect((await proposalOf(d.id)).phase).toBe('timed_out');

      advance(HOUR);
      await makeCoordinator().watchProposals(10);
      expect((await proposalOf(d.id)).phase).toBe('resolved');
      expect(logged('rewatch_window_ended')).toHaveLength(1);
    });
  });

  describe('committed amounts', () => {
    const committing = (approval: FakeApproval<'solana'>) => {
      const original = approval.buildImpl;
      approval.buildImpl = async (input) => {
        const built = await original(input);
        return built.ok
          ? ok({
              ...built.value,
              committed: { sender: [{ asset: 'USDC', amount: '100' }], proposer: [] },
            })
          : built;
      };
    };
    const held = async (s: ReturnType<typeof setup>) =>
      s.store.listCommitted(
        'solana',
        'sender',
        new Date(s.now().getTime() - DEFAULT_APPROVAL_REWATCH_WINDOW_MS),
      );

    it('a timed-out Proposal inside its window still counts; a late-settled one stops counting at once', async () => {
      const s = setup();
      committing(s.approval);
      await s.timedOut([item(1)]);
      expect(await held(s)).toEqual([{ asset: 'USDC', amount: '100' }]);

      s.approval.readImpl = () => Promise.resolve(ok(snapshot('active')));
      s.advance(DEFAULT_WATCH_INTERVAL_MS);
      await s.coordinator.watchProposals(10);
      expect(await held(s)).toEqual([{ asset: 'USDC', amount: '100' }]);

      s.approval.readImpl = () =>
        Promise.resolve(ok(snapshot('executed', { executedHash: 'human-exec' })));
      s.advance(DEFAULT_REWATCH_LATER_INTERVAL_MS);
      await s.coordinator.watchProposals(10);
      expect(await held(s)).toEqual([]);
    });

    it('stops counting at once on a late rejection', async () => {
      const s = setup();
      committing(s.approval);
      await s.timedOut([item(1)]);
      s.approval.readImpl = () => Promise.resolve(ok(snapshot('rejected')));
      s.advance(DEFAULT_WATCH_INTERVAL_MS);
      await s.coordinator.watchProposals(10);
      expect(await held(s)).toEqual([]);
    });

    it('stops counting when the window ends and the Proposal is resolved', async () => {
      const s = setup();
      committing(s.approval);
      const d = await s.timedOut([item(1)]);
      s.advance(DEFAULT_APPROVAL_REWATCH_WINDOW_MS - HOUR);
      expect(await held(s)).toEqual([{ asset: 'USDC', amount: '100' }]);

      s.advance(HOUR);
      await s.coordinator.watchProposals(10);
      expect((await s.proposalOf(d.id)).phase).toBe('resolved');
      expect(await held(s)).toEqual([]);
    });
  });

  describe('a second proposal reusing the sequence after a timeout (Safe supersede race)', () => {
    /** Reads answered per proposal, so each of the two proposals can be told apart. */
    const script = (
      approval: FakeApproval<'solana'>,
      answers: Record<string, ProposalSnapshot>,
    ) => {
      approval.readImpl = (ref: ChainProposalRef) => {
        const key = ref.kind === 'squads' ? ref.proposal : ref.safeTxHash;
        return Promise.resolve(ok(answers[key] ?? snapshot('active')));
      };
    };

    it('the old one executes first: the new one fails APPROVAL_REJECTED without ever being paid', async () => {
      const s = setup({ limit: 1 });
      const old = await s.timedOut([item(1)]);

      // The next proposal takes the freed slot (the old one no longer holds it).
      const fresh = await s.dispatch([item(2)]);
      await s.coordinator.processQueuedDispatches(10);
      await s.coordinator.watchProposals(10);
      const freshProposal = await s.proposalOf(fresh.id);
      const oldProposal = await s.proposalOf(old.id);
      expect(freshProposal.phase).toBe('open');
      expect(freshProposal.proposalRef).not.toBe(oldProposal.proposalRef);

      // A human executes the old one, which consumes the nonce the new one wanted.
      script(s.approval, {
        [oldProposal.proposalRef]: snapshot('executed', { executedHash: 'human-exec' }),
        [freshProposal.proposalRef]: snapshot('rejected'),
      });
      s.advance(DEFAULT_WATCH_INTERVAL_MS);
      await s.coordinator.watchProposals(10);

      expect(await s.rows(old.id)).toMatchObject([{ status: 'CONFIRMED', hash: 'human-exec' }]);
      const failed = await s.rows(fresh.id);
      expect(failed.map((t) => [t.status, t.error?.code, t.hash])).toEqual([
        ['FAILED', 'APPROVAL_REJECTED', null],
      ]);
      expect(s.handler.sign).not.toHaveBeenCalled();
      expect(s.handler.broadcast).not.toHaveBeenCalled();
    });

    it('the new one executes first: the old one is settled as rejected, and nothing is paid twice', async () => {
      const s = setup({ limit: 1 });
      const old = await s.timedOut([item(1)]);
      const fresh = await s.dispatch([item(2)]);
      await s.coordinator.processQueuedDispatches(10);
      await s.coordinator.watchProposals(10);
      const freshProposal = await s.proposalOf(fresh.id);
      const oldProposal = await s.proposalOf(old.id);

      // The new one is approved in time and the engine executes it, once.
      script(s.approval, {
        [oldProposal.proposalRef]: snapshot('active'),
        [freshProposal.proposalRef]: snapshot('approved'),
      });
      s.advance(DEFAULT_WATCH_INTERVAL_MS);
      await s.coordinator.watchProposals(10);
      expect(s.handler.broadcast).toHaveBeenCalledTimes(1);
      const executeHash = 'hash-of-signed-1';
      s.handler.statuses.set(executeHash, 'CONFIRMED');
      await s.coordinator.pollPendingTransactions(10);
      expect(await s.statuses(fresh.id)).toEqual(['CONFIRMED']);

      // Its execution consumed the nonce: the old one can never execute.
      script(s.approval, {
        [oldProposal.proposalRef]: snapshot('rejected'),
        [freshProposal.proposalRef]: snapshot('executed', { executedHash: executeHash }),
      });
      s.advance(DEFAULT_WATCH_INTERVAL_MS);
      await s.coordinator.watchProposals(10);

      expect((await s.rows(old.id)).map((t) => [t.status, t.error?.code])).toEqual([
        ['FAILED', 'APPROVAL_REJECTED'],
      ]);
      expect(await s.statuses(fresh.id)).toEqual(['CONFIRMED']);
      expect(s.handler.broadcast).toHaveBeenCalledTimes(1);
      expect((await s.proposalOf(old.id)).phase).toBe('resolved');
    });
  });

  describe('closing finished proposals durably', () => {
    it('a close that fails is remembered across a restart and finished by the next Coordinator', async () => {
      const s = setup();
      const d = await s.timedOut();
      s.approval.closeImpl = () => Promise.resolve(err(rpcDown));
      s.approval.readImpl = () => Promise.resolve(ok(snapshot('rejected')));
      s.advance(DEFAULT_WATCH_INTERVAL_MS);
      await s.coordinator.watchProposals(10);
      expect(await s.statuses(d.id)).toEqual(['FAILED', 'FAILED']);
      expect((await s.proposalOf(d.id)).closeState).toBe('pending');

      // The process dies; a new one starts with a working node.
      const closed: string[] = [];
      s.approval.closeImpl = (p) => {
        closed.push(p.id);
        return Promise.resolve(ok(undefined));
      };
      s.advance(HOUR);
      await s.makeCoordinator().watchProposals(10);

      expect(closed).toEqual([(await s.proposalOf(d.id)).id]);
      expect((await s.proposalOf(d.id)).closeState).toBe('closed');

      // Finished means finished: a later pass does not close it again.
      s.advance(HOUR);
      await s.makeCoordinator().watchProposals(10);
      expect(closed).toHaveLength(1);
    });

    it('gives up for good after repeated failures, recording it, and never starves others', async () => {
      const s = setup();
      const d = await s.timedOut();
      const attempts = vi.fn(() => Promise.resolve(err(rpcDown)));
      s.approval.closeImpl = attempts;
      s.approval.readImpl = () => Promise.resolve(ok(snapshot('rejected')));
      s.advance(DEFAULT_WATCH_INTERVAL_MS);
      await s.coordinator.watchProposals(10);

      for (let i = 0; i < 20; i++) {
        s.advance(10 * 60 * 1000);
        await s.coordinator.watchProposals(10);
      }
      expect(attempts).toHaveBeenCalledTimes(5);
      expect((await s.proposalOf(d.id)).closeState).toBe('abandoned');
      expect(await s.store.listProposalsAwaitingClose(['solana'], 10)).toEqual([]);
    });

    it('a chain that cannot close never marks anything pending', async () => {
      const s = setup();
      const d = await s.timedOut();
      Object.defineProperty(s.approval, 'closeProposal', { value: undefined });
      s.approval.readImpl = () => Promise.resolve(ok(snapshot('rejected')));
      s.advance(DEFAULT_WATCH_INTERVAL_MS);
      await s.coordinator.watchProposals(10);
      expect((await s.proposalOf(d.id)).closeState).toBeNull();
    });
  });
});
