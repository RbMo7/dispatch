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
import type { Call, DispatchItem, EvmCall, Payment } from '../domain/call.js';
import type { DispatchError } from '../domain/errors.js';
import { ok, type Result } from '../domain/result.js';
import type { SenderAddress, SenderRef } from '../domain/sender.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { Coordinator, type CoordinatorSender } from './coordinator.js';

const PAYOUTS: SenderRef = { chain: 'base', address: '0xpayouts' as SenderAddress };
const REFUNDS: SenderRef = { chain: 'base', address: '0xrefunds' as SenderAddress };
const TREASURY: SenderRef = { chain: 'base', address: '0xsafe' as SenderAddress };

const call = (n: number): EvmCall => ({ to: `0x${n}`, data: '0x', value: '1' });
const item = (n: number): DispatchItem<'base'> => ({
  call: call(n),
  payment: { recipient: `0x${n}`, asset: 'ETH', amount: '1' },
});

/** One Sender's handler: signs only as its own Sender, bundles every Call it is given into one transaction. */
class SenderHandler implements ChainHandler<'base'> {
  readonly chain = 'base';
  approval?: FakeApproval<'base'>;
  /** Resolves a broadcast; replace it to hold sends back. */
  broadcastGate: () => Promise<void> = () => Promise.resolve();
  readonly signedAs: string[] = [];
  readonly bundles: Call[][] = [];

  constructor(readonly name: string) {}

  paymentToCall = vi.fn((payment: Payment): Promise<Result<EvmCall, DispatchError>> =>
    Promise.resolve(ok({ to: payment.recipient, data: '0x', value: payment.amount })),
  );
  validateCall = vi.fn((_call: Call): Promise<Result<void, DispatchError>> =>
    Promise.resolve(ok(undefined)),
  );
  validateSignedTransaction = vi.fn(() => Promise.resolve(ok(undefined)));
  prepare = vi.fn(
    (
      items: Call[],
      senderAddress: string,
    ): Promise<Result<PreparedTransaction[], DispatchError>> => {
      this.bundles.push(items);
      const bundle = `${senderAddress}:${JSON.stringify(items)}`;
      return Promise.resolve(
        ok(items.map((_item, callIndex) => ({ callIndex, unsignedTransaction: bundle }))),
      );
    },
  );
  sign = vi.fn(
    (
      prepared: PreparedTransaction,
      senderAddress: string,
    ): Promise<Result<SignedTransaction, DispatchError>> => {
      this.signedAs.push(senderAddress);
      return Promise.resolve(ok(`signed:${prepared.unsignedTransaction}`));
    },
  );
  transactionHash = (signed: SignedTransaction): Result<string, DispatchError> =>
    ok(`hash:${signed}`);
  broadcast = vi.fn(
    async (signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>> => {
      await this.broadcastGate();
      return ok({ hash: `hash:${signed}` });
    },
  );
  getStatus = vi.fn((_hash: string): Promise<Result<ChainStatus, DispatchError>> =>
    Promise.resolve(ok('PENDING')),
  );
  getBalance = vi.fn((_address: string, asset: string): Promise<Result<Balance, DispatchError>> =>
    Promise.resolve(ok({ asset, amount: '1000' })),
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(extra: { treasury?: boolean } = {}) {
  const store = new InMemoryDispatchStore();
  const payouts = new SenderHandler('payouts');
  const refunds = new SenderHandler('refunds');
  const treasury = new SenderHandler('treasury');
  treasury.approval = new FakeApproval<'base'>();
  const senders: CoordinatorSender[] = [
    { ref: PAYOUTS, handler: payouts, isDefault: true },
    { ref: REFUNDS, handler: refunds, isDefault: false },
    ...(extra.treasury ? [{ ref: TREASURY, handler: treasury, isDefault: false }] : []),
  ];
  const coordinator = new Coordinator({
    store,
    chainHandlers: new Map([['base', payouts]]),
    senders,
    abandonmentTimeoutMs: new Map([['base', 600_000]]),
    sleep: () => Promise.resolve(),
    logger: pino({ level: 'silent' }),
  });
  let keys = 0;
  const dispatch = (sender: SenderRef | null, items: DispatchItem<'base'>[]) =>
    store.createDispatch({
      chain: 'base',
      idempotencyKey: `key-${keys++}`,
      items,
      retryPolicy: false,
      senderAddress: sender?.address ?? null,
    });
  const statusOf = async (id: string) =>
    (await store.listTransactions(id)).map((t) => ({ status: t.status, hash: t.hash }));
  const sentOf = async (id: string) =>
    (await store.listTransactions(id)).map((t) => ({ status: t.status, sent: t.hash !== null }));
  return { store, coordinator, payouts, refunds, treasury, dispatch, statusOf, sentOf };
}

describe('Coordinator with two Senders on one chain (ADR-0060)', () => {
  it("claims only a Sender's own Dispatches, and gives those stored with no Sender to the default", async () => {
    const { coordinator, store, dispatch, payouts, refunds } = setup();
    const toRefunds = await dispatch(REFUNDS, [item(1)]);
    const unassigned = await dispatch(null, [item(2)]);

    await coordinator.processQueuedDispatchesFor(REFUNDS, 10);
    expect(refunds.bundles).toEqual([[call(1)]]);
    expect((await store.getDispatch(unassigned.id))?.status).toBe('queued');

    await coordinator.processQueuedDispatchesFor(PAYOUTS, 10);
    expect(payouts.bundles).toEqual([[call(2)]]);
    expect(await store.getDispatch(unassigned.id)).toMatchObject({
      status: 'broadcasting',
      senderAddress: PAYOUTS.address,
    });
    expect((await store.getDispatch(toRefunds.id))?.senderAddress).toBe(REFUNDS.address);
  });

  it('never mixes Senders in one bundle: each Sender signs only its own Calls, as itself', async () => {
    const { coordinator, dispatch, payouts, refunds, statusOf } = setup();
    const a = await dispatch(PAYOUTS, [item(1), item(2)]);
    const b = await dispatch(REFUNDS, [item(3)]);
    const c = await dispatch(PAYOUTS, [item(4)]);

    await coordinator.processQueuedDispatches(10);

    expect(payouts.bundles).toEqual([[call(1), call(2), call(4)]]);
    expect(refunds.bundles).toEqual([[call(3)]]);
    expect(payouts.signedAs).toEqual([PAYOUTS.address]);
    expect(refunds.signedAs).toEqual([REFUNDS.address]);
    const [aHash] = (await statusOf(a.id)).map((t) => t.hash);
    expect((await statusOf(c.id))[0]?.hash).toBe(aHash);
    expect((await statusOf(b.id))[0]?.hash).not.toBe(aHash);
  });

  it("a send stuck on one Sender never delays another Sender's claims or sends", async () => {
    const { coordinator, dispatch, payouts, refunds, sentOf } = setup();
    const stuck = deferred();
    payouts.broadcastGate = () => stuck.promise;
    const held = await dispatch(PAYOUTS, [item(1)]);
    const first = await dispatch(REFUNDS, [item(2)]);

    const payoutsTick = coordinator.processQueuedDispatchesFor(PAYOUTS, 10);
    await coordinator.processQueuedDispatchesFor(REFUNDS, 10);
    const second = await dispatch(REFUNDS, [item(3)]);
    await coordinator.processQueuedDispatchesFor(REFUNDS, 10);

    expect(refunds.broadcast).toHaveBeenCalledTimes(2);
    for (const id of [first.id, second.id]) {
      expect(await sentOf(id)).toEqual([{ status: 'PENDING', sent: true }]);
    }
    // Written down before it was sent (ADR-0041), and still waiting on its own Sender.
    expect(payouts.broadcast).toHaveBeenCalledTimes(1);

    stuck.resolve();
    await payoutsTick;
    expect(await sentOf(held.id)).toEqual([{ status: 'PENDING', sent: true }]);
  });

  it('a Proposal waiting on a multisig Sender never holds up a plain Sender', async () => {
    const { coordinator, dispatch, store, treasury, refunds, statusOf, sentOf } = setup({
      treasury: true,
    });
    const building = deferred();
    const approval = treasury.approval as FakeApproval<'base'>;
    const build = approval.buildImpl;
    approval.buildImpl = async (input) => {
      await building.promise;
      return build(input);
    };
    const toTreasury = await dispatch(TREASURY, [item(1)]);
    const toRefunds = await dispatch(REFUNDS, [item(2)]);

    const treasuryTick = coordinator.processQueuedDispatchesFor(TREASURY, 10);
    await coordinator.processQueuedDispatchesFor(REFUNDS, 10);

    expect(await sentOf(toRefunds.id)).toEqual([{ status: 'PENDING', sent: true }]);
    expect(refunds.signedAs).toEqual([REFUNDS.address]);
    expect(await statusOf(toTreasury.id)).toEqual([{ status: 'UNPROPOSED', hash: null }]);

    building.resolve();
    await treasuryTick;
    expect(await statusOf(toTreasury.id)).toEqual([{ status: 'AWAITING_APPROVAL', hash: null }]);
    expect(approval.built.map((b) => b.sender)).toEqual([TREASURY.address]);
    expect((await store.listProposalsForDispatch(toTreasury.id))[0]?.senderAddress).toBe(
      TREASURY.address,
    );
    expect(treasury.sign).not.toHaveBeenCalled();
  });

  it("polls each Sender's transactions through that Sender's own handler", async () => {
    const { coordinator, dispatch, payouts, refunds } = setup();
    await dispatch(REFUNDS, [item(1)]);
    await coordinator.processQueuedDispatches(10);

    await coordinator.pollPendingTransactions(10);

    expect(refunds.getStatus).toHaveBeenCalledTimes(1);
    expect(payouts.getStatus).not.toHaveBeenCalled();
  });
});
