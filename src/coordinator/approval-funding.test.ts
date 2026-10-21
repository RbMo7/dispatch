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
import { Coordinator } from './coordinator.js';

const VAULT = 'vault';
const MEMBER = 'member-key';
const DAY = 24 * 60 * 60 * 1000;

const call = (n: number): SolanaCall => ({ programId: 'prog', accounts: [], data: `call-${n}` });
const pay = (n: number, asset: string, amount: string): DispatchItem<'solana'> => ({
  call: call(n),
  payment: { recipient: 'r', asset, amount },
});

/** A Chain Handler for a Multisig Sender; balances are set per address and asset. */
class MultisigHandler implements ChainHandler<'solana'> {
  readonly chain = 'solana';
  readonly approval = new FakeApproval<'solana'>();
  balances = new Map<string, string>();

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
  getBalance = vi.fn((address: string, asset: string): Promise<Result<Balance, DispatchError>> =>
    Promise.resolve(ok({ asset, amount: this.balances.get(`${address}:${asset}`) ?? '0' })),
  );
}

function setup() {
  let currentTime = new Date('2024-01-01T00:00:00.000Z');
  const store = new InMemoryDispatchStore(() => currentTime);
  const handler = new MultisigHandler();
  handler.approval.proposerAddress = MEMBER;
  handler.approval.estimateImpl = () =>
    Promise.resolve(ok({ asset: 'SOL', amount: '10', rentLocked: '4' }));
  const coordinator = new Coordinator({
    store,
    chainHandlers: new Map([['solana', handler]]),
    senderAddresses: new Map([['solana', VAULT]]),
    abandonmentTimeoutMs: new Map([['solana', 600_000]]),
    now: () => currentTime,
    sleep: () => Promise.resolve(),
    logger: pino({ level: 'silent' }),
  });
  let keys = 0;
  const dispatch = (items: DispatchItem<'solana'>[]) =>
    store.createDispatch({
      chain: 'solana',
      idempotencyKey: `key-${keys++}`,
      items,
      retryPolicy: false,
    });
  const fund = (address: string, asset: string, amount: string) =>
    handler.balances.set(`${address}:${asset}`, amount);
  const errors = async (dispatchId: string) =>
    (await store.listTransactions(dispatchId)).map((t) => [t.status, t.error?.chainDetail]);
  const advance = (ms: number) => {
    currentTime = new Date(currentTime.getTime() + ms);
  };
  return {
    store,
    handler,
    approval: handler.approval,
    coordinator,
    dispatch,
    fund,
    errors,
    advance,
  };
}

describe('Funding Check for a Multisig Sender (ADR-0043, ADR-0054)', () => {
  it('passes when the vault covers the payments and the member key covers the cost', async () => {
    const { coordinator, fund, dispatch, errors } = setup();
    fund(VAULT, 'USDC', '100');
    fund(MEMBER, 'SOL', '10');
    const d = await dispatch([pay(1, 'USDC', '100')]);

    await coordinator.processQueuedDispatches(10);

    expect(await errors(d.id)).toEqual([['AWAITING_APPROVAL', undefined]]);
  });

  it('names the vault when only the vault is short', async () => {
    const { coordinator, fund, dispatch, errors, approval } = setup();
    fund(VAULT, 'USDC', '60');
    fund(MEMBER, 'SOL', '10');
    const d = await dispatch([pay(1, 'USDC', '100')]);

    await coordinator.processQueuedDispatches(10);

    expect(await errors(d.id)).toEqual([
      ['FAILED', { asset: 'USDC', short: '40', holder: 'vault', address: VAULT, committed: '0' }],
    ]);
    expect(approval.built).toHaveLength(0);
  });

  it('names the member key when only the member key is short, using the proposal cost estimate', async () => {
    const { coordinator, fund, dispatch, errors, approval } = setup();
    fund(VAULT, 'USDC', '100');
    fund(MEMBER, 'SOL', '3');
    const d = await dispatch([pay(1, 'USDC', '100')]);

    await coordinator.processQueuedDispatches(10);

    expect(await errors(d.id)).toEqual([
      [
        'FAILED',
        { asset: 'SOL', short: '7', holder: 'memberKey', address: MEMBER, committed: '0' },
      ],
    ]);
    expect(approval.built).toHaveLength(0);
  });

  it('fails a Call once even when both balances are short, naming the first requirement', async () => {
    const { coordinator, dispatch, errors, store } = setup();
    const d = await dispatch([pay(1, 'USDC', '100')]);

    await coordinator.processQueuedDispatches(10);

    expect(await store.listTransactions(d.id)).toHaveLength(1);
    expect(await errors(d.id)).toEqual([
      ['FAILED', { asset: 'USDC', short: '100', holder: 'vault', address: VAULT, committed: '0' }],
    ]);
  });

  it('pays payments from the vault even when the payment asset is the native one', async () => {
    const { coordinator, fund, dispatch, errors, handler } = setup();
    fund(VAULT, 'SOL', '50');
    fund(MEMBER, 'SOL', '10');
    const d = await dispatch([pay(1, 'SOL', '50')]);

    await coordinator.processQueuedDispatches(10);

    expect(await errors(d.id)).toEqual([['AWAITING_APPROVAL', undefined]]);
    expect(handler.getBalance).toHaveBeenCalledWith(VAULT, 'SOL');
    expect(handler.getBalance).toHaveBeenCalledWith(MEMBER, 'SOL');
  });

  it('asks the capability for the cost, never the plain networkCost', async () => {
    const { coordinator, fund, dispatch, handler, approval } = setup();
    const networkCost = vi.fn(() => Promise.resolve(ok({ asset: 'SOL', amount: '999' })));
    Object.assign(handler, { networkCost });
    const estimate = vi.spyOn(approval, 'estimateApprovalCost');
    fund(VAULT, 'USDC', '100');
    fund(MEMBER, 'SOL', '10');
    const d = await dispatch([pay(1, 'USDC', '100')]);

    await coordinator.processQueuedDispatches(10);

    expect(networkCost).not.toHaveBeenCalled();
    expect(estimate).toHaveBeenCalledWith(
      d.items.map((i) => i.call),
      VAULT,
    );
  });

  it('fails every Call when the cost cannot be estimated', async () => {
    const { coordinator, fund, dispatch, errors, approval } = setup();
    approval.estimateImpl = () =>
      Promise.resolve(err({ code: 'RPC_UNAVAILABLE', message: 'down' }));
    fund(VAULT, 'USDC', '100');
    const d = await dispatch([pay(1, 'USDC', '100')]);

    await coordinator.processQueuedDispatches(10);

    expect(await errors(d.id)).toEqual([['FAILED', undefined]]);
  });

  describe('committed amounts', () => {
    /** Each built Proposal commits its Calls' payments on the vault and `rent` on the member key. */
    function committing(ctx: ReturnType<typeof setup>, rent: string) {
      const original = ctx.approval.buildImpl;
      ctx.approval.buildImpl = async (input) => {
        const result = await original(input);
        if (!result.ok) return result;
        const total = input.calls.length * 100;
        return ok({
          ...result.value,
          committed: {
            sender: [{ asset: 'USDC', amount: String(total) }],
            proposer: [{ asset: 'SOL', amount: rent }],
          },
        });
      };
    }

    it('an open Proposal makes a second Dispatch fail, naming the committed amount', async () => {
      const ctx = setup();
      committing(ctx, '0');
      ctx.fund(VAULT, 'USDC', '150');
      ctx.fund(MEMBER, 'SOL', '100');
      const first = await ctx.dispatch([pay(1, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);
      expect(await ctx.errors(first.id)).toEqual([['AWAITING_APPROVAL', undefined]]);

      const second = await ctx.dispatch([pay(2, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);

      expect(await ctx.errors(second.id)).toEqual([
        [
          'FAILED',
          { asset: 'USDC', short: '50', holder: 'vault', address: VAULT, committed: '100' },
        ],
      ]);
    });

    it('a Proposal resolved since then no longer counts', async () => {
      const ctx = setup();
      committing(ctx, '0');
      ctx.fund(VAULT, 'USDC', '150');
      ctx.fund(MEMBER, 'SOL', '100');
      const first = await ctx.dispatch([pay(1, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);
      const [proposal] = await ctx.store.listProposalsForDispatch(first.id);
      await ctx.store.settleProposal(proposal?.id as string, { status: 'CONFIRMED', hash: 'h' });

      const second = await ctx.dispatch([pay(2, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);

      expect(await ctx.errors(second.id)).toEqual([['AWAITING_APPROVAL', undefined]]);
    });

    it('a timed-out Proposal still counts inside the watch window and stops after it', async () => {
      const ctx = setup();
      committing(ctx, '0');
      ctx.fund(VAULT, 'USDC', '150');
      ctx.fund(MEMBER, 'SOL', '100');
      const first = await ctx.dispatch([pay(1, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);
      const [proposal] = await ctx.store.listProposalsForDispatch(first.id);
      await ctx.store.settleProposal(proposal?.id as string, {
        status: 'ABANDONED',
        error: { code: 'APPROVAL_TIMEOUT', message: 'late' },
      });

      ctx.advance(29 * DAY);
      const inside = await ctx.dispatch([pay(2, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);
      expect(await ctx.errors(inside.id)).toEqual([
        [
          'FAILED',
          { asset: 'USDC', short: '50', holder: 'vault', address: VAULT, committed: '100' },
        ],
      ]);

      ctx.advance(2 * DAY);
      const outside = await ctx.dispatch([pay(3, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);
      expect(await ctx.errors(outside.id)).toEqual([['AWAITING_APPROVAL', undefined]]);
    });

    it("UNPROPOSED rows' payments count against the vault", async () => {
      const ctx = setup();
      ctx.approval.signImpl = () =>
        Promise.resolve(err({ code: 'SIGNER_UNREACHABLE', message: 'signer down' }));
      ctx.fund(VAULT, 'USDC', '150');
      ctx.fund(MEMBER, 'SOL', '100');
      const first = await ctx.dispatch([pay(1, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);
      expect(await ctx.errors(first.id)).toEqual([['UNPROPOSED', undefined]]);

      const second = await ctx.dispatch([pay(2, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);

      expect(await ctx.errors(second.id)).toEqual([
        [
          'FAILED',
          { asset: 'USDC', short: '50', holder: 'vault', address: VAULT, committed: '100' },
        ],
      ]);
    });

    it('rent locked on the member key counts against its balance', async () => {
      const ctx = setup();
      committing(ctx, '4');
      ctx.fund(VAULT, 'USDC', '1000');
      ctx.fund(MEMBER, 'SOL', '15');
      const first = await ctx.dispatch([pay(1, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);
      expect(await ctx.errors(first.id)).toEqual([['AWAITING_APPROVAL', undefined]]);

      // 15 - 4 locked = 11 available, enough for 10; with 8 locked only 7 is left.
      const second = await ctx.dispatch([pay(2, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);
      expect(await ctx.errors(second.id)).toEqual([['AWAITING_APPROVAL', undefined]]);

      const third = await ctx.dispatch([pay(3, 'USDC', '100')]);
      await ctx.coordinator.processQueuedDispatches(10);
      expect(await ctx.errors(third.id)).toEqual([
        [
          'FAILED',
          { asset: 'SOL', short: '3', holder: 'memberKey', address: MEMBER, committed: '8' },
        ],
      ]);
    });
  });

  describe('Base labels', () => {
    it('uses the labels the capability declares', async () => {
      const { coordinator, approval, dispatch, errors } = setup();
      approval.holders = { sender: 'safe', proposer: 'executor' };
      const d = await dispatch([pay(1, 'USDC', '100')]);

      await coordinator.processQueuedDispatches(10);

      expect(await errors(d.id)).toEqual([
        ['FAILED', { asset: 'USDC', short: '100', holder: 'safe', address: VAULT, committed: '0' }],
      ]);
    });
  });
});

describe('Funding Check for a plain Sender is unchanged', () => {
  it('keeps { asset, short } and never reads committed amounts', async () => {
    const store = new InMemoryDispatchStore();
    const listCommitted = vi.spyOn(store, 'listCommitted');
    const handler = new MultisigHandler();
    Object.assign(handler, { approval: undefined });
    handler.balances.set('sender-address:USDC', '60');
    const coordinator = new Coordinator({
      store,
      chainHandlers: new Map([['solana', handler]]),
      senderAddresses: new Map([['solana', 'sender-address']]),
      abandonmentTimeoutMs: new Map([['solana', 600_000]]),
      sleep: () => Promise.resolve(),
      logger: pino({ level: 'silent' }),
    });
    const d = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'plain',
      items: [pay(1, 'USDC', '100')],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    const [row] = await store.listTransactions(d.id);
    expect(row?.error).toEqual({
      code: 'INSUFFICIENT_FUNDS',
      message: 'insufficient USDC balance',
      chainDetail: { asset: 'USDC', short: '40' },
    });
    expect(listCommitted).not.toHaveBeenCalled();
  });
});
