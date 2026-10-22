import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type {
  Balance,
  BroadcastResult,
  ChainHandler,
  ChainStatus,
  PreparedTransaction,
  SignedTransaction,
} from '../chain-handler/chain-handler.js';
import { FakeApproval } from '../chain-handler/test-support/fake-approval.js';
import type { Call, DispatchItem, Payment, SolanaCall } from '../domain/call.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { DEFAULT_APPROVAL_DEADLINE_MS } from './approval-flow.js';
import { Coordinator } from './coordinator.js';

const call = (n: number): SolanaCall => ({ programId: 'prog', accounts: [], data: `call-${n}` });
const item = (n: number): DispatchItem<'solana'> => ({ call: call(n), payment: null });

/** A Chain Handler for a Multisig Sender: the plain send path must never be reached. */
class MultisigHandler implements ChainHandler<'solana'> {
  readonly chain = 'solana';
  readonly approval = new FakeApproval<'solana'>();

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
  sign = vi.fn((): Promise<Result<SignedTransaction, DispatchError>> =>
    Promise.resolve(ok('signed')),
  );
  transactionHash = vi.fn((): Result<string, DispatchError> => ok('hash'));
  broadcast = vi.fn((): Promise<Result<BroadcastResult, DispatchError>> =>
    Promise.resolve(ok({ hash: 'hash' })),
  );
  getStatus = vi.fn((): Promise<Result<ChainStatus, DispatchError>> =>
    Promise.resolve(ok('PENDING')),
  );
  getBalance = vi.fn((_address: string, asset: string): Promise<Result<Balance, DispatchError>> =>
    Promise.resolve(ok({ asset, amount: '1000000' })),
  );
}

function setup(options: { approvalDeadlineMs?: number } = {}) {
  let currentTime = new Date('2024-01-01T00:00:00.000Z');
  const clock = () => currentTime;
  const advance = (ms: number) => {
    currentTime = new Date(currentTime.getTime() + ms);
  };
  const store = new InMemoryDispatchStore(clock);
  const handler = new MultisigHandler();
  const coordinator = new Coordinator({
    store,
    chainHandlers: new Map([['solana', handler]]),
    senderAddresses: new Map([['solana', 'vault']]),
    abandonmentTimeoutMs: new Map([['solana', 600_000]]),
    now: clock,
    sleep: () => Promise.resolve(),
    logger: pino({ level: 'silent' }),
    ...options,
  });

  let keys = 0;
  const dispatch = (items: DispatchItem<'solana'>[]) =>
    store.createDispatch({
      chain: 'solana',
      idempotencyKey: `key-${keys++}`,
      items,
      retryPolicy: false,
    });
  const statuses = async (dispatchId: string) =>
    (await store.listTransactions(dispatchId))
      .sort((a, b) => a.callIndex - b.callIndex)
      .map((t) => t.status);
  const proposalsOf = (dispatchId: string) => store.listProposalsForDispatch(dispatchId);

  return {
    store,
    handler,
    approval: handler.approval,
    coordinator,
    advance,
    dispatch,
    statuses,
    proposalsOf,
  };
}

describe('ApprovalFlow: proposing a Dispatch to a Multisig Sender (ADR-0054)', () => {
  it('turns a Dispatch into a Proposal and its Calls AWAITING_APPROVAL, written down before it is sent', async () => {
    const { coordinator, store, handler, approval, dispatch, statuses, proposalsOf } = setup();
    const d = await dispatch([item(1), item(2), item(3)]);
    let noted: string | null = null;
    approval.submitImpl = async () => {
      // ADR-0041: by the time the send happens, the proposal and its bytes are already persisted.
      const [proposal] = await proposalsOf(d.id);
      noted = proposal ? `${proposal.phase}:${proposal.proposeSignedBytes}` : null;
      return ok(undefined);
    };

    await coordinator.processQueuedDispatches(10);

    expect(noted).toBe('noted:signed-prop-1');
    expect(await statuses(d.id)).toEqual([
      'AWAITING_APPROVAL',
      'AWAITING_APPROVAL',
      'AWAITING_APPROVAL',
    ]);
    const [proposal, ...rest] = await proposalsOf(d.id);
    expect(rest).toEqual([]);
    expect(proposal).toMatchObject({
      dispatchId: d.id,
      chain: 'solana',
      senderAddress: 'vault',
      phase: 'open', // confirmed sent, so the next proposal may use the following sequence
      proposalRef: 'prop-1',
      proposeHash: 'hash-prop-1',
      proposeSignedBytes: 'signed-prop-1',
      sequence: 1,
    });
    const calls = await store.listProposalCalls(proposal?.id as string);
    expect(calls.map((c) => [c.callIndex, c.proposalPosition])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(approval.built[0]?.sender).toBe('vault');
    // The Sender never signs: the plain send path is not touched.
    expect(handler.prepare).not.toHaveBeenCalled();
    expect(handler.sign).not.toHaveBeenCalled();
    expect(handler.broadcast).not.toHaveBeenCalled();
  });

  it('sets the deadline from the configured approval deadline, 72 hours by default', async () => {
    const a = setup();
    const da = await a.dispatch([item(1)]);
    await a.coordinator.processQueuedDispatches(10);
    const [pa] = await a.proposalsOf(da.id);
    expect(pa?.deadlineAt.getTime()).toBe(
      Date.parse('2024-01-01T00:00:00.000Z') + DEFAULT_APPROVAL_DEADLINE_MS,
    );

    const b = setup({ approvalDeadlineMs: 60_000 });
    const db = await b.dispatch([item(1)]);
    await b.coordinator.processQueuedDispatches(10);
    const [pb] = await b.proposalsOf(db.id);
    expect(pb?.deadlineAt.getTime()).toBe(Date.parse('2024-01-01T00:01:00.000Z'));
  });

  it('splits a Dispatch into several Proposals as the Chain Handler plans them', async () => {
    const { coordinator, approval, dispatch, statuses, proposalsOf, store } = setup();
    approval.bundleSize = 2;
    const d = await dispatch([item(1), item(2), item(3), item(4), item(5)]);

    await coordinator.processQueuedDispatches(10);

    const proposals = await proposalsOf(d.id);
    expect(proposals).toHaveLength(3);
    const sizes = await Promise.all(
      proposals.map(async (p) => (await store.listProposalCalls(p.id)).length),
    );
    expect(sizes).toEqual([2, 2, 1]);
    expect(await statuses(d.id)).toEqual(Array(5).fill('AWAITING_APPROVAL'));
  });

  it('never mixes Calls of two Dispatches in one Proposal, creating them one at a time', async () => {
    const { coordinator, approval, dispatch, proposalsOf, store } = setup();
    const a = await dispatch([item(1), item(2)]);
    const b = await dispatch([item(3)]);

    await coordinator.processQueuedDispatches(10);

    const [pa] = await proposalsOf(a.id);
    const [pb] = await proposalsOf(b.id);
    expect(pa && pb && pa.id !== pb.id).toBe(true);
    expect((await store.listProposalCalls(pa?.id as string)).map((c) => c.dispatchId)).toEqual([
      a.id,
      a.id,
    ]);
    expect((await store.listProposalCalls(pb?.id as string)).map((c) => c.dispatchId)).toEqual([
      b.id,
    ]);
    expect(approval.planned.map((calls) => calls.length)).toEqual([2, 1]); // planned per Dispatch
    // Creation is serialized: each Proposal is built, signed and sent before the next is built.
    expect(approval.events).toEqual([
      'build:prop-1',
      'sign:prop-1',
      'submit:hash-prop-1',
      'build:prop-2',
      'sign:prop-2',
      'submit:hash-prop-2',
    ]);
  });

  it('serializes creation per Sender even when ticks overlap', async () => {
    const { coordinator, approval, dispatch } = setup();
    await dispatch([item(1)]);
    await dispatch([item(2)]);
    let running = 0;
    let overlap = false;
    const original = approval.buildImpl;
    approval.buildImpl = async (input) => {
      running++;
      if (running > 1) overlap = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await original(input);
      running--;
      return result;
    };

    await Promise.all([
      coordinator.processQueuedDispatches(10),
      coordinator.processQueuedDispatches(10),
    ]);

    expect(overlap).toBe(false);
    expect(approval.built).toHaveLength(2);
  });

  it('with an open-proposal limit of 1, a second Dispatch waits UNPROPOSED until the first resolves', async () => {
    const { coordinator, approval, dispatch, statuses, proposalsOf, store } = setup();
    approval.openProposalLimit = 1;
    const a = await dispatch([item(1)]);
    const b = await dispatch([item(2)]);

    await coordinator.processQueuedDispatches(10);
    expect(await statuses(a.id)).toEqual(['AWAITING_APPROVAL']);
    expect(await statuses(b.id)).toEqual(['UNPROPOSED']);

    // Still full on the next tick, even with nothing newly claimed.
    await coordinator.processQueuedDispatches(10);
    expect(await statuses(b.id)).toEqual(['UNPROPOSED']);
    expect(approval.built).toHaveLength(1);

    const [first] = await proposalsOf(a.id);
    await store.updateProposal(first?.id as string, { phase: 'resolved' });
    await coordinator.processQueuedDispatches(10);
    expect(await statuses(b.id)).toEqual(['AWAITING_APPROVAL']);
    expect(await proposalsOf(b.id)).toHaveLength(1);
  });

  it('hands the Chain Handler minSequence = the highest CONFIRMED sequence + 1, and nothing when none is confirmed (#84)', async () => {
    const { coordinator, store, approval, dispatch, proposalsOf } = setup();
    const a = await dispatch([item(1)]);
    await coordinator.processQueuedDispatches(10);
    expect(approval.built[0]).not.toHaveProperty('minSequence');

    // Only a CONFIRMED execution is known to have consumed its sequence.
    const [first] = await proposalsOf(a.id);
    await store.settleProposal(first?.id as string, { status: 'CONFIRMED', hash: 'h1' });
    const b = await dispatch([item(2)]);
    await coordinator.processQueuedDispatches(10);
    expect(approval.built[1]?.minSequence).toBe(2); // the first was built at sequence 1

    const [second] = await proposalsOf(b.id);
    await store.settleProposal(second?.id as string, {
      status: 'FAILED',
      error: { code: 'CHAIN_REJECTED', message: 'reverted' },
    });
    await dispatch([item(3)]);
    await coordinator.processQueuedDispatches(10);
    expect(approval.built[2]?.minSequence).toBe(2); // the failed one (sequence 2) consumed nothing
  });

  it('with an unlimited open-proposal limit, both Dispatches get Proposals in one tick', async () => {
    const { coordinator, dispatch, statuses } = setup();
    const a = await dispatch([item(1)]);
    const b = await dispatch([item(2)]);
    await coordinator.processQueuedDispatches(10);
    expect(await statuses(a.id)).toEqual(['AWAITING_APPROVAL']);
    expect(await statuses(b.id)).toEqual(['AWAITING_APPROVAL']);
  });

  it('a limit of 1 stops partway through a Dispatch that needs several Proposals', async () => {
    const { coordinator, approval, dispatch, statuses } = setup();
    approval.openProposalLimit = 1;
    approval.bundleSize = 1;
    const d = await dispatch([item(1), item(2)]);
    await coordinator.processQueuedDispatches(10);
    expect(await statuses(d.id)).toEqual(['AWAITING_APPROVAL', 'UNPROPOSED']);
  });

  describe('signing', () => {
    it('SIGNER_REFUSED fails the Calls for good and is never retried', async () => {
      const { coordinator, approval, dispatch, statuses, store } = setup();
      const refusal: DispatchError = { code: 'SIGNER_REFUSED', message: 'policy says no' };
      approval.signImpl = () => Promise.resolve(err(refusal));
      const d = await dispatch([item(1), item(2)]);

      await coordinator.processQueuedDispatches(10);
      await coordinator.processQueuedDispatches(10);
      await coordinator.processQueuedDispatches(10);

      expect(await statuses(d.id)).toEqual(['FAILED', 'FAILED']);
      expect((await store.listTransactions(d.id)).map((t) => t.error)).toEqual([refusal, refusal]);
      expect(approval.events.filter((e) => e.startsWith('sign-failed'))).toHaveLength(1);
      expect(await store.listProposalsForDispatch(d.id)).toEqual([]);
    });

    it('SIGNER_UNREACHABLE leaves the Calls UNPROPOSED and retries after a backoff', async () => {
      const { coordinator, approval, dispatch, statuses, advance } = setup();
      let reachable = false;
      const original = approval.signImpl;
      approval.signImpl = (built) =>
        reachable
          ? original(built)
          : Promise.resolve(err({ code: 'SIGNER_UNREACHABLE', message: 'no signer' }));
      const d = await dispatch([item(1)]);

      await coordinator.processQueuedDispatches(10);
      expect(await statuses(d.id)).toEqual(['UNPROPOSED']);
      const attempts = approval.events.filter(
        (e) => e === 'build:prop-1' || e === 'build:prop-2',
      ).length;

      // Within the backoff nothing is tried again.
      await coordinator.processQueuedDispatches(10);
      expect(approval.events.filter((e) => e.startsWith('build:'))).toHaveLength(attempts);

      reachable = true;
      advance(60_000);
      await coordinator.processQueuedDispatches(10);
      expect(await statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
    });

    it('SIGNER_UNREACHABLE backs off only its own chain-wide pass, and the backoff grows', async () => {
      const { coordinator, approval, dispatch, advance } = setup();
      approval.signImpl = () =>
        Promise.resolve(err({ code: 'SIGNER_UNREACHABLE', message: 'no signer' }));
      await dispatch([item(1)]);
      const signAttempts = () => approval.events.filter((e) => e.startsWith('sign-failed')).length;

      await coordinator.processQueuedDispatches(10);
      expect(signAttempts()).toBe(1);
      advance(5_000); // the first backoff is 5s
      await coordinator.processQueuedDispatches(10);
      expect(signAttempts()).toBe(2);
      advance(5_000); // the second is 10s, so this is too early
      await coordinator.processQueuedDispatches(10);
      expect(signAttempts()).toBe(2);
      advance(5_000);
      await coordinator.processQueuedDispatches(10);
      expect(signAttempts()).toBe(3);
    });
  });

  describe('crashes (ADR-0041)', () => {
    it('a crash while signing leaves the Calls UNPROPOSED and no Proposal', async () => {
      const { coordinator, approval, dispatch, statuses, proposalsOf } = setup();
      approval.signImpl = () => Promise.reject(new Error('process died'));
      const d = await dispatch([item(1)]);

      await expect(coordinator.processQueuedDispatches(10)).rejects.toThrow('process died');

      expect(await statuses(d.id)).toEqual(['UNPROPOSED']);
      expect(await proposalsOf(d.id)).toEqual([]);
    });

    it('a failed write between signing and sending leaves the Calls UNPROPOSED and nothing sent', async () => {
      const { coordinator, approval, store, dispatch, statuses, advance } = setup();
      const original = store.createProposal.bind(store);
      const write = vi.spyOn(store, 'createProposal').mockRejectedValueOnce(new Error('db down'));
      const d = await dispatch([item(1)]);

      await coordinator.processQueuedDispatches(10);

      expect(await statuses(d.id)).toEqual(['UNPROPOSED']);
      expect(approval.submitted).toEqual([]);
      expect(approval.signed).toHaveLength(1);

      write.mockImplementation(original);
      advance(60_000);
      await coordinator.processQueuedDispatches(10);
      expect(await statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
    });

    it('a crash after the write but before the send leaves a noted Proposal with its bytes', async () => {
      const { coordinator, approval, dispatch, statuses, proposalsOf } = setup();
      approval.submitImpl = () => Promise.reject(new Error('process died'));
      const d = await dispatch([item(1)]);

      await expect(coordinator.processQueuedDispatches(10)).rejects.toThrow('process died');

      expect(await statuses(d.id)).toEqual(['AWAITING_APPROVAL']);
      const [proposal] = await proposalsOf(d.id);
      expect(proposal).toMatchObject({
        phase: 'noted',
        proposeSignedBytes: 'signed-prop-1',
        proposeHash: 'hash-prop-1',
      });
    });

    it('builds nothing on top of a Proposal that is still noted, even once the backoff has passed', async () => {
      const { coordinator, approval, dispatch, statuses, advance } = setup();
      approval.submitImpl = () =>
        Promise.resolve(err({ code: 'RPC_UNAVAILABLE', message: 'node down' }));
      await dispatch([item(1)]);
      const b = await dispatch([item(2)]);
      await coordinator.processQueuedDispatches(10);
      const built = approval.built.length;

      advance(60 * 60 * 1000); // far past the backoff
      approval.submitImpl = () => Promise.resolve(ok(undefined));
      await coordinator.processQueuedDispatches(10);

      // The first Proposal still holds the next sequence, so a second would collide with it.
      expect(await statuses(b.id)).toEqual(['UNPROPOSED']);
      expect(approval.built).toHaveLength(built);
    });

    it('a refused send leaves the Proposal noted, stops proposing and does not fail the Calls', async () => {
      const { coordinator, approval, dispatch, statuses, proposalsOf } = setup();
      approval.submitImpl = () =>
        Promise.resolve(err({ code: 'RPC_UNAVAILABLE', message: 'node down' }));
      const a = await dispatch([item(1)]);
      const b = await dispatch([item(2)]);

      await coordinator.processQueuedDispatches(10);

      expect(await statuses(a.id)).toEqual(['AWAITING_APPROVAL']);
      expect((await proposalsOf(a.id))[0]?.phase).toBe('noted');
      expect(await statuses(b.id)).toEqual(['UNPROPOSED']); // backing off after the failed send
    });
  });

  describe('planning and building', () => {
    it('fails every Call of a Dispatch with the error planBundles returns', async () => {
      const { coordinator, approval, dispatch, store, statuses } = setup();
      const tooBig: DispatchError = { code: 'CHAIN_REJECTED', message: 'a call is too big' };
      const a = await dispatch([item(1), item(2)]);
      const b = await dispatch([item(3)]);
      approval.planBundlesImpl = (calls) => (calls.length === 2 ? err(tooBig) : ok([[0]]));

      await coordinator.processQueuedDispatches(10);

      expect(await statuses(a.id)).toEqual(['FAILED', 'FAILED']);
      expect((await store.listTransactions(a.id)).map((t) => t.error)).toEqual([tooBig, tooBig]);
      expect(await statuses(b.id)).toEqual(['AWAITING_APPROVAL']); // the next Dispatch is unaffected
    });

    it('fails the Calls rather than loop forever on a plan that is not a partition', async () => {
      const { coordinator, approval, dispatch, statuses } = setup();
      approval.planBundlesImpl = () => ok([[0], [0]]);
      const d = await dispatch([item(1), item(2)]);
      await coordinator.processQueuedDispatches(10);
      expect(await statuses(d.id)).toEqual(['FAILED', 'FAILED']);
    });

    it('a definite buildProposal error fails the Calls; RPC_UNAVAILABLE leaves them UNPROPOSED', async () => {
      const { coordinator, approval, dispatch, statuses, advance } = setup();
      approval.buildImpl = () =>
        Promise.resolve(err({ code: 'RPC_UNAVAILABLE', message: 'node down' }));
      const a = await dispatch([item(1)]);
      await coordinator.processQueuedDispatches(10);
      expect(await statuses(a.id)).toEqual(['UNPROPOSED']);

      approval.buildImpl = () => Promise.resolve(err({ code: 'CHAIN_REJECTED', message: 'bad' }));
      advance(60_000);
      await coordinator.processQueuedDispatches(10);
      expect(await statuses(a.id)).toEqual(['FAILED']);
    });
  });

  describe('claiming', () => {
    it('fails an invalid Call on its own and proposes the rest', async () => {
      const { coordinator, handler, dispatch, statuses } = setup();
      handler.validateCall.mockImplementation((c: Call) =>
        Promise.resolve(
          'data' in c && c.data === 'call-2'
            ? err({ code: 'INVALID_RECIPIENT', message: 'bad call' })
            : ok(undefined),
        ),
      );
      const d = await dispatch([item(1), item(2), item(3)]);
      await coordinator.processQueuedDispatches(10);
      expect(await statuses(d.id)).toEqual(['AWAITING_APPROVAL', 'FAILED', 'AWAITING_APPROVAL']);
    });

    it('still runs the Funding Check first', async () => {
      const { coordinator, handler, dispatch, statuses } = setup();
      handler.getBalance.mockImplementation((_a: string, asset: string) =>
        Promise.resolve(ok({ asset, amount: '5' })),
      );
      const d = await dispatch([
        { call: call(1), payment: { recipient: 'r', asset: 'USDC', amount: '10' } },
      ]);
      await coordinator.processQueuedDispatches(10);
      expect(await statuses(d.id)).toEqual(['FAILED']);
    });

    it('a reclaimed stale claim is proposed, never signed as the Sender', async () => {
      const { coordinator, handler, approval, store, dispatch, statuses, advance } = setup();
      const d = await dispatch([item(1), item(2)]);
      await store.claimQueued(['solana'], 10); // claimed by a worker that then died

      advance(10 * 60 * 1000);
      await coordinator.reclaimStaleClaims(10);
      expect(await statuses(d.id)).toEqual(['UNPROPOSED', 'UNPROPOSED']);
      await coordinator.processQueuedDispatches(10);

      expect(await statuses(d.id)).toEqual(['AWAITING_APPROVAL', 'AWAITING_APPROVAL']);
      expect(approval.built).toHaveLength(1);
      expect(handler.prepare).not.toHaveBeenCalled();
      expect(handler.sign).not.toHaveBeenCalled();
    });
  });

  describe('waiting work', () => {
    it('counts UNPROPOSED and AWAITING_APPROVAL Calls as work waiting on a chain', async () => {
      const { coordinator, approval, dispatch, store } = setup();
      approval.openProposalLimit = 1;
      await dispatch([item(1)]);
      await dispatch([item(2)]);
      await coordinator.processQueuedDispatches(10);
      expect(await store.countWaitingWork(['solana'])).toEqual(new Map([['solana', 2]]));
    });
  });
});
