import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Balance,
  BroadcastResult,
  ChainHandler,
  ChainStatus,
  PreparedTransaction,
  SignedTransaction,
} from '../chain-handler/chain-handler.js';
import { SafeApproval } from '../chain-handler/base/safe/safe-approval.js';
import type { BaseSafeConfig } from '../chain-handler/base/safe/safe-config.js';
import { SafeTxServiceClient } from '../chain-handler/base/safe/tx-service-client.js';
import {
  SAFE,
  byHashPath,
  ecdsaSignature,
  executionSuccessReceipt,
  executor,
  fakeNode,
  ownerKeys,
  owners,
  serviceTransaction,
  startFakeService,
  type FakeService,
} from '../chain-handler/test-support/fake-safe.js';
import { encodeUnsignedTransaction } from '../chain-handler/base/transaction-codec.js';
import type { Call, DispatchItem, EvmCall, Payment } from '../domain/call.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { Coordinator } from './coordinator.js';
import { registryFromConfig } from '../asset-registry/configured-assets.js';

/**
 * #84/#85 wired end to end offline: the real Safe approval capability over a
 * fake node and service, driven by the real ApprovalFlow and Funding Check.
 */
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const A = '0x1111111111111111111111111111111111111111';

const nativeItem = (amount: string): DispatchItem<'base'> => ({
  call: { to: A, value: amount, data: '0x' },
  payment: { recipient: A, asset: 'ETH', amount },
});
const usdcItem = (amount: bigint): DispatchItem<'base'> => ({
  call: {
    to: USDC,
    value: '0',
    data: `0xa9059cbb${A.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`,
  },
  payment: { recipient: A, asset: 'USDC', amount: amount.toString() },
});

class BaseSafeHandler implements ChainHandler<'base'> {
  readonly chain = 'base';
  balances = new Map<string, string>();
  constructor(readonly approval: SafeApproval) {}

  paymentToCall = vi.fn((_p: Payment): Promise<Result<EvmCall, DispatchError>> =>
    Promise.resolve(err({ code: 'UNKNOWN_ASSET', message: 'unused' })),
  );
  validateCall = vi.fn((_c: Call): Promise<Result<void, DispatchError>> =>
    Promise.resolve(ok(undefined)),
  );
  validateSignedTransaction = vi.fn((_s: SignedTransaction): Promise<Result<void, DispatchError>> =>
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

let service: FakeService | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
});

async function setup() {
  service = await startFakeService();
  const node = fakeNode({ nonce: 12n });
  const config: BaseSafeConfig = {
    safeAddress: SAFE,
    executorAddress: executor.address,
    txServiceUrl: service.url,
    apiKey: undefined,
    approvalDeadlineMs: 72 * 3_600_000,
    approvalRewatchWindowMs: 30 * 24 * 3_600_000,
    bundleLimit: 50,
  };
  const approval = new SafeApproval({
    config,
    chainId: 84532,
    client: node.client,
    signer: {
      // The engine signs the proposal as the delegate; any well-formed signature will do offline.
      signSafeTransaction: () => Promise.resolve(ok(`0x${'11'.repeat(64)}1b` as `0x${string}`)),
    },
    service: new SafeTxServiceClient({ baseUrl: service.url }),
    assets: registryFromConfig({ base: `USDC:${USDC}:${6}` }).forChain('base'),
    prepare: (items) =>
      Promise.resolve(
        ok(
          items.map((item, callIndex) => ({
            callIndex,
            unsignedTransaction: encodeUnsignedTransaction({
              senderAddress: executor.address,
              chainId: 84532,
              nonce: null,
              to: item.to as `0x${string}`,
              value: item.value,
              data: item.data as `0x${string}`,
              gas: '500000',
              maxFeePerGas: '2000000',
              maxPriorityFeePerGas: '1000000',
              preparedId: 'p',
            }),
          })),
        ),
      ),
    staleReadRetryDelayMs: 0,
  });
  // The propose POST goes to the fake service.
  service.routes.set(`/api/v2/safes/${SAFE}/multisig-transactions/`, { status: 201 });

  let now = new Date('2024-01-01T00:00:00.000Z');
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const store = new InMemoryDispatchStore(() => now);
  const handler = new BaseSafeHandler(approval);
  const coordinator = new Coordinator({
    store,
    chainHandlers: new Map([['base', handler]]),
    senderAddresses: new Map([['base', SAFE]]),
    abandonmentTimeoutMs: new Map([['base', 600_000]]),
    now: () => now,
    sleep: () => Promise.resolve(),
    logger: pino({ level: 'silent' }),
  });
  let keys = 0;
  const dispatch = (items: DispatchItem<'base'>[]) =>
    store.createDispatch({
      chain: 'base',
      idempotencyKey: `key-${keys++}`,
      items,
      retryPolicy: false,
    });
  const outcome = async (dispatchId: string) =>
    (await store.listTransactions(dispatchId)).map((t) => [t.status, t.error?.chainDetail]);
  const fund = (address: string, asset: string, amount: string) =>
    handler.balances.set(`${address}:${asset}`, amount);
  return { node, approval, store, handler, coordinator, dispatch, outcome, fund, advance, service };
}

describe('a Safe proposal that was never posted (the watch recovers it)', () => {
  const POST = `/api/v2/safes/${SAFE}/multisig-transactions/`;
  const funded = async () => {
    const t = await setup();
    t.fund(SAFE, 'ETH', '100');
    t.fund(executor.address, 'ETH', '1000000000000000000');
    return t;
  };

  it('re-posts a proposal whose first POST failed, instead of opening it unposted', async () => {
    const t = await funded();
    t.service.routes.set(POST, { status: 503 });
    const d = await t.dispatch([nativeItem('5')]);
    await t.coordinator.processQueuedDispatches(10);
    const [noted] = await t.store.listProposalsForDispatch(d.id);
    expect(noted?.phase).toBe('noted');
    const posts = () => t.service.hits.filter((h) => h.path === POST).length;
    const before = posts();

    t.service.routes.set(POST, { status: 201 });
    t.advance(61_000);
    await t.coordinator.watchProposals(10);

    // The service had never seen it, so it is posted again; it is only open once that worked.
    expect(posts()).toBe(before + 1);
    const [opened] = await t.store.listProposalsForDispatch(d.id);
    expect(opened?.phase).toBe('open');
  });

  it('fails the Calls when the service definitively refuses the proposal, since it never existed', async () => {
    const t = await funded();
    t.service.routes.set(POST, {
      status: 422,
      body: { nonFieldErrors: ['Sender is not an owner or delegate'] },
    });
    const d = await t.dispatch([nativeItem('5')]);
    await t.coordinator.processQueuedDispatches(10);

    t.advance(61_000);
    await t.coordinator.watchProposals(10);

    expect(
      (await t.store.listTransactions(d.id)).map((row) => [row.status, row.error?.code]),
    ).toEqual([['FAILED', 'CHAIN_REJECTED']]);
    const [proposal] = await t.store.listProposalsForDispatch(d.id);
    expect(proposal?.phase).toBe('resolved');
    // Nothing is stuck behind it: the next Dispatch can be proposed.
    expect(await t.store.hasNotedProposal('base', SAFE)).toBe(false);
  });
});

describe('the stale-nonce guard through ApprovalFlow', () => {
  it("proposes the next Dispatch at N+1 right after the engine's own execution, though the chain read is stale", async () => {
    const t = await setup();
    t.fund(SAFE, 'ETH', '1000');
    t.fund(executor.address, 'ETH', '1000000000000000000');
    const first = await t.dispatch([nativeItem('5')]);
    await t.coordinator.processQueuedDispatches(10);
    const [p1] = await t.store.listProposalsForDispatch(first.id);
    expect(p1).toMatchObject({ sequence: 12, phase: 'open' });

    // The engine executes it: CONFIRMED. The node's read of nonce() still says 12 (stale).
    await t.store.settleProposal(p1!.id, { status: 'CONFIRMED', hash: '0xexec' });
    expect(t.node.state.nonce).toBe(12n);

    const second = await t.dispatch([nativeItem('6')]);
    await t.coordinator.processQueuedDispatches(10);
    const [p2] = await t.store.listProposalsForDispatch(second.id);
    expect(p2).toMatchObject({ sequence: 13, chainRef: { kind: 'safe', nonce: 13 } });
  });

  it('does not count an execute that failed: a reverted execute leaves the nonce unchanged', async () => {
    const t = await setup();
    t.fund(SAFE, 'ETH', '1000');
    t.fund(executor.address, 'ETH', '1000000000000000000');
    const first = await t.dispatch([nativeItem('5')]);
    await t.coordinator.processQueuedDispatches(10);
    const [p1] = await t.store.listProposalsForDispatch(first.id);
    await t.store.settleProposal(p1!.id, {
      status: 'FAILED',
      error: { code: 'CHAIN_REJECTED', message: 'execute reverted' },
    });

    const second = await t.dispatch([nativeItem('6')]);
    await t.coordinator.processQueuedDispatches(10);
    const [p2] = await t.store.listProposalsForDispatch(second.id);
    expect(p2).toMatchObject({ sequence: 12 });
  });

  it('lets a higher chain nonce win when an owner executed something else', async () => {
    const t = await setup();
    t.fund(SAFE, 'ETH', '1000');
    t.fund(executor.address, 'ETH', '1000000000000000000');
    const first = await t.dispatch([nativeItem('5')]);
    await t.coordinator.processQueuedDispatches(10);
    const [p1] = await t.store.listProposalsForDispatch(first.id);
    await t.store.settleProposal(p1!.id, { status: 'CONFIRMED', hash: '0xexec' });
    t.node.state.nonce = 20n; // owners executed other transactions in between

    const second = await t.dispatch([nativeItem('6')]);
    await t.coordinator.processQueuedDispatches(10);
    const [p2] = await t.store.listProposalsForDispatch(second.id);
    expect(p2).toMatchObject({ sequence: 20 });
  });
});

describe('the Funding Check for a Safe Sender (#85)', () => {
  it('blocks the next Dispatch from spending what an open proposal already holds, native and ERC-20', async () => {
    const t = await setup();
    t.fund(SAFE, 'ETH', '100');
    t.fund(SAFE, 'USDC', '100');
    t.fund(executor.address, 'ETH', '1000000000000000000');
    const first = await t.dispatch([nativeItem('80'), usdcItem(80n)]);
    await t.coordinator.processQueuedDispatches(10);
    expect((await t.outcome(first.id)).map(([status]) => status)).toEqual([
      'AWAITING_APPROVAL',
      'AWAITING_APPROVAL',
    ]);

    const second = await t.dispatch([nativeItem('30'), usdcItem(30n)]);
    await t.coordinator.processQueuedDispatches(10);
    expect(await t.outcome(second.id)).toEqual([
      ['FAILED', { asset: 'ETH', short: '10', holder: 'safe', address: SAFE, committed: '80' }],
      ['FAILED', { asset: 'USDC', short: '10', holder: 'safe', address: SAFE, committed: '80' }],
    ]);
  });

  it('names the executor, with its asset and shortfall, when its gas is short', async () => {
    const t = await setup();
    t.fund(SAFE, 'ETH', '100');
    const estimate = await t.approval.estimateApprovalCost([nativeItem('5').call], SAFE);
    if (!estimate.ok) throw new Error('estimate failed');
    const cost = BigInt(estimate.value.amount);
    t.fund(executor.address, 'ETH', (cost - 1n).toString());

    const d = await t.dispatch([nativeItem('5')]);
    await t.coordinator.processQueuedDispatches(10);

    expect(await t.outcome(d.id)).toEqual([
      [
        'FAILED',
        {
          asset: 'ETH',
          short: '1',
          holder: 'executor',
          address: executor.address,
          committed: '0',
        },
      ],
    ]);
  });

  it("counts an open proposal's execute gas against the executor too", async () => {
    const t = await setup();
    t.fund(SAFE, 'ETH', '1000');
    const estimate = await t.approval.estimateApprovalCost([nativeItem('5').call], SAFE);
    if (!estimate.ok) throw new Error('estimate failed');
    const cost = BigInt(estimate.value.amount);
    // Enough gas for one proposal and a half: the second Dispatch must be refused.
    t.fund(executor.address, 'ETH', (cost + cost / 2n).toString());

    const first = await t.dispatch([nativeItem('5')]);
    await t.coordinator.processQueuedDispatches(10);
    expect((await t.outcome(first.id))[0]?.[0]).toBe('AWAITING_APPROVAL');

    const second = await t.dispatch([nativeItem('5')]);
    await t.coordinator.processQueuedDispatches(10);
    expect(await t.outcome(second.id)).toEqual([
      [
        'FAILED',
        {
          asset: 'ETH',
          short: (cost - cost / 2n).toString(),
          holder: 'executor',
          address: executor.address,
          committed: cost.toString(),
        },
      ],
    ]);
  });

  it('passes when the Safe and the executor are both funded', async () => {
    const t = await setup();
    t.fund(SAFE, 'ETH', '5');
    t.fund(SAFE, 'USDC', '9');
    t.fund(executor.address, 'ETH', '1000000000000000000');
    const d = await t.dispatch([nativeItem('5'), usdcItem(9n)]);
    await t.coordinator.processQueuedDispatches(10);
    expect((await t.outcome(d.id)).map(([status]) => status)).toEqual([
      'AWAITING_APPROVAL',
      'AWAITING_APPROVAL',
    ]);
  });
});

describe('watching a Safe proposal through ApprovalFlow (#84)', () => {
  async function approved() {
    const t = await setup();
    t.fund(SAFE, 'ETH', '100');
    t.fund(executor.address, 'ETH', '1000000000000000000');
    const d = await t.dispatch([nativeItem('5')]);
    await t.coordinator.processQueuedDispatches(10);
    const [proposal] = await t.store.listProposalsForDispatch(d.id);
    const hash = proposal!.proposalRef as `0x${string}`;
    const confirmations = await Promise.all(
      [0, 1].map(async (i) => ({
        owner: owners[i]!.address,
        signature: await ecdsaSignature(ownerKeys[i]!, hash),
      })),
    );
    t.service.routes.set(byHashPath(hash), {
      status: 200,
      body: serviceTransaction({ safeTxHash: hash, nonce: 12, confirmations }),
    });
    return { ...t, d, proposal: proposal!, hash };
  }

  it('executes an approved proposal: the Calls go PENDING with the execute written down first', async () => {
    const t = await approved();
    t.advance(61_000);
    await t.coordinator.watchProposals(10);
    expect(await t.outcome(t.d.id)).toEqual([['PENDING', undefined]]);
    expect(t.handler.sign).toHaveBeenCalledWith(expect.anything(), executor.address);
    expect(t.handler.broadcast).toHaveBeenCalledTimes(1);
  });

  it('never fails the Calls on a GS013 simulation while the proposal can still execute; the deadline abandons it', async () => {
    const t = await approved();
    t.node.state.callResult = new Error('execution reverted: GS013');
    t.advance(61_000);
    await t.coordinator.watchProposals(10);
    expect(await t.outcome(t.d.id)).toEqual([['AWAITING_APPROVAL', undefined]]);
    expect(t.handler.broadcast).not.toHaveBeenCalled();

    // The Safe is funded in the meantime and the simulation clears: it executes.
    t.node.state.callResult = `0x${'0'.repeat(63)}1`;
    t.advance(5 * 60_000);
    await t.coordinator.watchProposals(10);
    expect(await t.outcome(t.d.id)).toEqual([['PENDING', undefined]]);
  });

  it('abandons a proposal fully confirmed only after its deadline, and never executes it', async () => {
    const t = await approved();
    t.advance(72 * 3_600_000 + 1);
    await t.coordinator.watchProposals(10);
    expect((await t.outcome(t.d.id))[0]?.[0]).toBe('ABANDONED');
    expect(t.handler.broadcast).not.toHaveBeenCalled();
  });

  it('fails the Calls with APPROVAL_REJECTED when a different transaction took the nonce', async () => {
    const t = await approved();
    t.node.state.nonce = 13n;
    t.service.routes.set(`/api/v2/safes/${SAFE}/multisig-transactions/?nonce=12`, {
      status: 200,
      body: {
        results: [
          { safeTxHash: `0x${'ab'.repeat(32)}`, isExecuted: true, transactionHash: '0x01' },
        ],
      },
    });
    t.advance(61_000);
    await t.coordinator.watchProposals(10);
    const [tx] = await t.store.listTransactions(t.d.id);
    expect(tx).toMatchObject({ status: 'FAILED', error: { code: 'APPROVAL_REJECTED' } });
  });

  it('confirms the Calls with the executing hash when someone else executed it', async () => {
    const t = await approved();
    t.node.state.nonce = 13n;
    t.node.state.receipts.set(`0x${'cd'.repeat(32)}`, executionSuccessReceipt(t.hash));
    t.service.routes.set(byHashPath(t.hash), {
      status: 200,
      body: serviceTransaction({
        safeTxHash: t.hash,
        nonce: 12,
        isExecuted: true,
        transactionHash: `0x${'cd'.repeat(32)}`,
      }),
    });
    t.advance(61_000);
    await t.coordinator.watchProposals(10);
    const [tx] = await t.store.listTransactions(t.d.id);
    expect(tx).toMatchObject({ status: 'CONFIRMED', hash: `0x${'cd'.repeat(32)}` });
  });
});
