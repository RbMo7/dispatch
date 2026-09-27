import { describe, expect, it, vi } from 'vitest';

import type {
  Balance,
  BroadcastResult,
  BundleSlotStatus,
  ChainHandler,
  ChainStatus,
  PreparedTransaction,
  SignedTransaction,
} from '../chain-handler/chain-handler.js';
import type { Call, DispatchItem, EvmCall, Payment, SolanaCall } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { Coordinator } from './coordinator.js';

const solanaCall: SolanaCall = { programId: 'prog', accounts: [], data: 'ZGF0YQ==' };
const solanaItem: DispatchItem<'solana'> = { call: solanaCall, payment: null };
const evmCall: EvmCall = { to: '0xabc', data: '0x', value: '0' };
const evmItem: DispatchItem<'base'> = { call: evmCall, payment: null };

/**
 * A fully configurable ChainHandler test double — deliberately not the
 * same StubChainHandler used to prove the conformance suite (issue 05),
 * since that one is fixed/no-op and can't produce every branch (prepare
 * failure, sign failure, a FAILED on-chain status, an RPC error from
 * getStatus) the Coordinator's orchestration logic needs to be exercised
 * against. Every method defaults to succeeding; tests override just the
 * one they're exercising.
 */
class FakeChainHandler implements ChainHandler {
  readonly chain: Chain;

  paymentToCall = vi.fn((_payment: Payment): Promise<Result<Call, DispatchError>> =>
    Promise.resolve(ok({ programId: 'prog', accounts: [], data: 'ZGF0YQ==' })),
  );
  validateCall = vi.fn((_call: Call): Promise<Result<void, DispatchError>> =>
    Promise.resolve(ok(undefined)),
  );
  validateSignedTransaction = vi.fn(
    (_signed: SignedTransaction): Promise<Result<void, DispatchError>> =>
      Promise.resolve(ok(undefined)),
  );
  prepare = vi.fn(
    (
      items: Call[],
      _senderAddress: string,
    ): Promise<Result<PreparedTransaction[], DispatchError>> =>
      Promise.resolve(
        ok(
          items.map((item, callIndex) => ({
            callIndex,
            unsignedTransaction: JSON.stringify(item),
          })),
        ),
      ),
  );
  sign = vi.fn(
    (
      _prepared: PreparedTransaction,
      _senderAddress: string,
    ): Promise<Result<SignedTransaction, DispatchError>> => Promise.resolve(ok('signed-bytes')),
  );
  /** Matches broadcast's default hash — a real chain's broadcast reports exactly what this computes. */
  transactionHash = vi.fn((_signed: SignedTransaction): Result<string, DispatchError> =>
    ok('hash-1'),
  );
  broadcast = vi.fn((_signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>> =>
    Promise.resolve(ok({ hash: 'hash-1' })),
  );
  getStatus = vi.fn((_hash: string): Promise<Result<ChainStatus, DispatchError>> =>
    Promise.resolve(ok('PENDING')),
  );
  getBalance = vi.fn((_address: string, asset: string): Promise<Result<Balance, DispatchError>> =>
    Promise.resolve(ok({ asset, amount: '0' })),
  );

  constructor(chain: Chain) {
    this.chain = chain;
  }
}

const ABANDON_AFTER_MS = 10 * 60 * 1000;
const RECHECK_WINDOW_MS = 10 * 60 * 1000;

function setup() {
  let currentTime = new Date('2024-01-01T00:00:00.000Z');
  const clock = () => currentTime;
  const advance = (ms: number) => {
    currentTime = new Date(currentTime.getTime() + ms);
  };

  const store = new InMemoryDispatchStore(clock);
  const handler = new FakeChainHandler('solana');
  const coordinator = new Coordinator({
    store,
    chainHandlers: new Map([['solana', handler]]),
    senderAddresses: new Map([['solana', 'sender-address']]),
    abandonmentTimeoutMs: new Map([['solana', ABANDON_AFTER_MS]]),
    now: clock,
    sleep: () => Promise.resolve(), // no real backoff delay in tests (relay-dispatch issue 01's bounded retry)
  });

  return { store, handler, coordinator, advance };
}

/** Like setup(), but with the reorg safety net (issue 07) opted in for 'solana' — the Coordinator's own logic is chain-agnostic, so which chain name is used to exercise it doesn't matter. */
function setupWithReorgRecheck() {
  let currentTime = new Date('2024-01-01T00:00:00.000Z');
  const clock = () => currentTime;
  const advance = (ms: number) => {
    currentTime = new Date(currentTime.getTime() + ms);
  };

  const store = new InMemoryDispatchStore(clock);
  const handler = new FakeChainHandler('solana');
  const coordinator = new Coordinator({
    store,
    chainHandlers: new Map([['solana', handler]]),
    senderAddresses: new Map([['solana', 'sender-address']]),
    abandonmentTimeoutMs: new Map([['solana', ABANDON_AFTER_MS]]),
    reorgRecheckWindowMs: new Map([['solana', RECHECK_WINDOW_MS]]),
    now: clock,
    sleep: () => Promise.resolve(),
  });

  return { store, handler, coordinator, advance };
}

/** A FakeChainHandler for a chain that can fee-bump (#9) — the optional `prepareReplacement` present. */
class BumpingFakeChainHandler extends FakeChainHandler {
  prepareReplacement = vi.fn(
    (
      _signed: SignedTransaction,
      _senderAddress: string,
    ): Promise<Result<PreparedTransaction, DispatchError>> =>
      Promise.resolve(ok({ callIndex: 0, unsignedTransaction: 'bumped-unsigned' })),
  );
}

const STUCK_AFTER_MS = 60_000;
const MAX_FEE_BUMPS = 2;

/** 'base' opted into fee-bump handling (#9, ADR-0037); `canBump: false` models an opted-in chain whose handler has no prepareReplacement. */
function setupWithStuckHandling({ canBump = true }: { canBump?: boolean } = {}) {
  let currentTime = new Date('2024-01-01T00:00:00.000Z');
  const clock = () => currentTime;
  const advance = (ms: number) => {
    currentTime = new Date(currentTime.getTime() + ms);
  };

  const store = new InMemoryDispatchStore(clock);
  const handler = canBump ? new BumpingFakeChainHandler('base') : new FakeChainHandler('base');
  const coordinator = new Coordinator({
    store,
    chainHandlers: new Map([['base', handler]]),
    senderAddresses: new Map([['base', 'sender-address']]),
    abandonmentTimeoutMs: new Map([['base', ABANDON_AFTER_MS]]),
    stuckHandling: new Map([
      ['base', { stuckAfterMs: STUCK_AFTER_MS, maxFeeBumps: MAX_FEE_BUMPS }],
    ]),
    now: clock,
    sleep: () => Promise.resolve(),
  });

  return { store, handler, coordinator, advance };
}

describe('Coordinator.processQueuedDispatches', () => {
  it('drives a Call through validate/prepare/sign/broadcast and persists a PENDING Transaction', async () => {
    const { store, handler, coordinator } = setup();
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.validateCall).toHaveBeenCalledWith(solanaCall);
    expect(handler.prepare).toHaveBeenCalledWith([solanaCall], 'sender-address');
    expect(handler.broadcast).toHaveBeenCalledWith('signed-bytes');

    const transactions = await store.listTransactions(dispatch.id);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      callIndex: 0,
      status: 'PENDING',
      hash: 'hash-1',
      signedBytes: 'signed-bytes',
    });
  });

  it('records a Call failure when validateCall rejects it, without ever calling prepare', async () => {
    const { store, handler, coordinator } = setup();
    handler.validateCall.mockResolvedValueOnce(
      err({ code: 'INVALID_RECIPIENT', message: 'malformed recipient' }),
    );
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.prepare).not.toHaveBeenCalled();
    const [transaction] = await store.listTransactions(dispatch.id);
    expect(transaction).toMatchObject({
      status: 'FAILED',
      hash: null,
      signedBytes: null,
      error: { code: 'INVALID_RECIPIENT', message: 'malformed recipient' },
    });
  });

  it('records a Call failure when prepare fails, without ever calling sign', async () => {
    const { store, handler, coordinator } = setup();
    handler.prepare.mockResolvedValueOnce(err({ code: 'RPC_UNAVAILABLE', message: 'rpc down' }));
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.sign).not.toHaveBeenCalled();
    const [transaction] = await store.listTransactions(dispatch.id);
    expect(transaction?.status).toBe('FAILED');
    expect(transaction?.error).toEqual({ code: 'RPC_UNAVAILABLE', message: 'rpc down' });
  });

  it('records a Call failure when sign fails, without ever calling broadcast', async () => {
    const { store, handler, coordinator } = setup();
    handler.sign.mockResolvedValueOnce(err({ code: 'SIGNER_UNREACHABLE', message: 'no signer' }));
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.broadcast).not.toHaveBeenCalled();
    const [transaction] = await store.listTransactions(dispatch.id);
    expect(transaction?.status).toBe('FAILED');
    expect(transaction?.error).toEqual({ code: 'SIGNER_UNREACHABLE', message: 'no signer' });
  });

  it('records a Call failure when broadcast fails', async () => {
    const { store, handler, coordinator } = setup();
    handler.broadcast.mockResolvedValueOnce(
      err({ code: 'CHAIN_REJECTED', message: 'simulation failed' }),
    );
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    const [transaction] = await store.listTransactions(dispatch.id);
    expect(transaction?.status).toBe('FAILED');
    expect(transaction?.error).toEqual({ code: 'CHAIN_REJECTED', message: 'simulation failed' });
  });

  it('processes each Call in a Dispatch independently — one failing never blocks another', async () => {
    const { store, handler, coordinator } = setup();
    handler.validateCall.mockResolvedValueOnce(
      err({ code: 'INVALID_RECIPIENT', message: 'bad recipient' }),
    );
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [solanaItem, solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    const transactions = await store.listTransactions(dispatch.id);
    expect(transactions.map((t) => t.status)).toEqual(['FAILED', 'PENDING']);
  });

  it('throws when a claimed Dispatch names a chain with no registered ChainHandler', async () => {
    const { store, coordinator } = setup();
    await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'key-1',
      items: [evmItem],
      retryPolicy: false,
    });

    await expect(coordinator.processQueuedDispatches(10)).rejects.toThrow(
      /No ChainHandler registered/,
    );
  });
});

describe('Coordinator bundling (solana-chain-handler issue 13)', () => {
  it('signs and broadcasts a bundle exactly once, then fans the one hash out to every contributing Call — even across separate Dispatches claimed in the same tick', async () => {
    const { store, handler, coordinator } = setup();
    handler.prepare.mockImplementationOnce((items, _senderAddress) =>
      Promise.resolve(
        ok(items.map((_item, callIndex) => ({ callIndex, unsignedTransaction: 'bundle-1' }))),
      ),
    );
    const dispatchA = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-a',
      items: [solanaItem],
      retryPolicy: false,
    });
    const dispatchB = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-b',
      items: [solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.prepare).toHaveBeenCalledTimes(1);
    expect(handler.prepare).toHaveBeenCalledWith([solanaCall, solanaCall], 'sender-address');
    expect(handler.sign).toHaveBeenCalledTimes(1);
    expect(handler.broadcast).toHaveBeenCalledTimes(1);

    const [txA] = await store.listTransactions(dispatchA.id);
    const [txB] = await store.listTransactions(dispatchB.id);
    expect(txA).toMatchObject({ status: 'PENDING', hash: 'hash-1', signedBytes: 'signed-bytes' });
    expect(txB).toMatchObject({ status: 'PENDING', hash: 'hash-1', signedBytes: 'signed-bytes' });
  });

  it('excludes an invalid Call from the bundle without blocking the rest — prepare only ever sees Calls that passed validateCall', async () => {
    const { store, handler, coordinator } = setup();
    handler.validateCall.mockImplementation((call) =>
      Promise.resolve(
        (call as SolanaCall).programId === 'bad'
          ? err({ code: 'INVALID_RECIPIENT', message: 'malformed recipient' })
          : ok(undefined),
      ),
    );
    handler.prepare.mockImplementationOnce((items, _senderAddress) =>
      Promise.resolve(
        ok(items.map((_item, callIndex) => ({ callIndex, unsignedTransaction: 'bundle-1' }))),
      ),
    );
    const badItem: DispatchItem<'solana'> = {
      call: { programId: 'bad', accounts: [], data: 'ZGF0YQ==' },
      payment: null,
    };
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [solanaItem, badItem, solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.prepare).toHaveBeenCalledWith([solanaCall, solanaCall], 'sender-address');
    const transactions = await store.listTransactions(dispatch.id);
    expect(transactions.map((t) => t.status)).toEqual(['PENDING', 'FAILED', 'PENDING']);
  });

  it('fails every Call sharing a bundle when sign fails for it, not just one', async () => {
    const { store, handler, coordinator } = setup();
    handler.prepare.mockImplementationOnce((items, _senderAddress) =>
      Promise.resolve(
        ok(items.map((_item, callIndex) => ({ callIndex, unsignedTransaction: 'bundle-1' }))),
      ),
    );
    handler.sign.mockResolvedValueOnce(err({ code: 'SIGNER_UNREACHABLE', message: 'no signer' }));
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [solanaItem, solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.sign).toHaveBeenCalledTimes(1);
    expect(handler.broadcast).not.toHaveBeenCalled();
    const transactions = await store.listTransactions(dispatch.id);
    expect(transactions.map((t) => t.status)).toEqual(['FAILED', 'FAILED']);
    expect(transactions[0]?.error).toEqual({ code: 'SIGNER_UNREACHABLE', message: 'no signer' });
  });

  it('fails every still-valid Call in the claimed batch when prepare itself fails', async () => {
    const { store, handler, coordinator } = setup();
    handler.prepare.mockResolvedValueOnce(err({ code: 'RPC_UNAVAILABLE', message: 'rpc down' }));
    const dispatchA = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-a',
      items: [solanaItem],
      retryPolicy: false,
    });
    const dispatchB = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-b',
      items: [solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    const [txA] = await store.listTransactions(dispatchA.id);
    const [txB] = await store.listTransactions(dispatchB.id);
    expect(txA?.status).toBe('FAILED');
    expect(txB?.status).toBe('FAILED');
    expect(txA?.error).toEqual({ code: 'RPC_UNAVAILABLE', message: 'rpc down' });
  });
});

function paymentItem(asset: string, amount: string): DispatchItem<'solana'> {
  return { call: solanaCall, payment: { recipient: 'recipient', asset, amount } };
}

describe('Coordinator Funding Check', () => {
  it('fails a Call with INSUFFICIENT_FUNDS when the required amount exceeds the Sender balance, without ever calling validateCall', async () => {
    const { store, handler, coordinator } = setup();
    handler.getBalance.mockResolvedValueOnce(ok({ asset: 'USDC', amount: '40' }));
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [paymentItem('USDC', '100')],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.validateCall).not.toHaveBeenCalled();
    const [transaction] = await store.listTransactions(dispatch.id);
    expect(transaction?.status).toBe('FAILED');
    expect(transaction?.error).toEqual({
      code: 'INSUFFICIENT_FUNDS',
      message: 'insufficient USDC balance',
      chainDetail: { asset: 'USDC', short: '60' },
    });
  });

  it('proceeds normally when the Sender balance covers the required amount', async () => {
    const { store, handler, coordinator } = setup();
    handler.getBalance.mockResolvedValueOnce(ok({ asset: 'USDC', amount: '100' }));
    await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [paymentItem('USDC', '100')],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.validateCall).toHaveBeenCalledTimes(1);
  });

  it('aggregates the required amount across every payment-backed item sharing an asset before checking the balance', async () => {
    const { store, handler, coordinator } = setup();
    handler.getBalance.mockResolvedValueOnce(ok({ asset: 'USDC', amount: '150' }));
    await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [paymentItem('USDC', '80'), paymentItem('USDC', '80')],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.getBalance).toHaveBeenCalledTimes(1);
    expect(handler.getBalance).toHaveBeenCalledWith('sender-address', 'USDC');
    expect(handler.validateCall).not.toHaveBeenCalled();
  });

  it('aggregates the required amount across separate Dispatches claimed in the same batch', async () => {
    const { store, handler, coordinator } = setup();
    handler.getBalance.mockResolvedValueOnce(ok({ asset: 'USDC', amount: '150' }));
    const first = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [paymentItem('USDC', '80')],
      retryPolicy: false,
    });
    const second = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-2',
      items: [paymentItem('USDC', '80')],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.getBalance).toHaveBeenCalledTimes(1);
    const [firstTransaction] = await store.listTransactions(first.id);
    const [secondTransaction] = await store.listTransactions(second.id);
    expect(firstTransaction?.status).toBe('FAILED');
    expect(secondTransaction?.status).toBe('FAILED');
    expect(firstTransaction?.error?.chainDetail).toEqual({ asset: 'USDC', short: '10' });
  });

  it('never fund-checks a call-type item, since it has no Payment to derive a required amount from', async () => {
    const { store, handler, coordinator } = setup();
    await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [solanaItem],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.getBalance).not.toHaveBeenCalled();
    expect(handler.validateCall).toHaveBeenCalledTimes(1);
  });

  it('fails the affected Calls when getBalance itself fails, rather than proceeding unverified', async () => {
    const { store, handler, coordinator } = setup();
    handler.getBalance.mockResolvedValueOnce(err({ code: 'RPC_UNAVAILABLE', message: 'rpc down' }));
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [paymentItem('USDC', '100')],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.validateCall).not.toHaveBeenCalled();
    const [transaction] = await store.listTransactions(dispatch.id);
    expect(transaction?.status).toBe('FAILED');
    expect(transaction?.error).toEqual({ code: 'RPC_UNAVAILABLE', message: 'rpc down' });
  });
});

describe('Coordinator.pollPendingTransactions', () => {
  async function createPendingTransaction(
    store: InMemoryDispatchStore,
    retryPolicy: boolean,
  ): Promise<string> {
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'key-1',
      items: [solanaItem],
      retryPolicy,
    });
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'solana',
      signedBytes: 'signed-bytes',
      hash: 'hash-1',
    });
    return transaction.id;
  }

  it('marks a Transaction confirmed once the Chain Handler reports CONFIRMED', async () => {
    const { store, handler, coordinator } = setup();
    const transactionId = await createPendingTransaction(store, false);
    handler.getStatus.mockResolvedValueOnce(ok('CONFIRMED'));

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('CONFIRMED');
  });

  it('marks a Transaction failed with CHAIN_REJECTED once the Chain Handler reports FAILED', async () => {
    const { store, handler, coordinator } = setup();
    const transactionId = await createPendingTransaction(store, false);
    handler.getStatus.mockResolvedValueOnce(ok('FAILED'));

    await coordinator.pollPendingTransactions(10);

    const transaction = store.getTransaction(transactionId);
    expect(transaction?.status).toBe('FAILED');
    expect(transaction?.error?.code).toBe('CHAIN_REJECTED');
  });

  it('leaves a still-PENDING Transaction alone once getStatus itself fails, before its timeout elapses', async () => {
    const { store, handler, coordinator } = setup();
    const transactionId = await createPendingTransaction(store, false);
    handler.getStatus.mockResolvedValueOnce(err({ code: 'RPC_UNAVAILABLE', message: 'rpc down' }));

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('PENDING');
  });

  it('still applies the ABANDONED timeout once it elapses even if getStatus keeps failing', async () => {
    const { store, handler, coordinator, advance } = setup();
    const transactionId = await createPendingTransaction(store, false);
    advance(ABANDON_AFTER_MS);
    handler.getStatus.mockResolvedValue(err({ code: 'RPC_UNAVAILABLE', message: 'rpc down' }));

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('ABANDONED');
  });

  it('leaves a still-PENDING Transaction alone before its chain-aware ABANDONED timeout elapses', async () => {
    const { store, handler, coordinator, advance } = setup();
    const transactionId = await createPendingTransaction(store, false);
    advance(ABANDON_AFTER_MS - 1);
    handler.getStatus.mockResolvedValue(ok('PENDING'));

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('PENDING');
  });

  it('marks a still-PENDING Transaction ABANDONED once its chain-aware timeout elapses, with Retry Policy off', async () => {
    const { store, handler, coordinator, advance } = setup();
    const transactionId = await createPendingTransaction(store, false);
    advance(ABANDON_AFTER_MS);
    handler.getStatus.mockResolvedValue(ok('PENDING'));

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('ABANDONED');
  });

  it('abandons a still-PENDING Retry-Policy-on Transaction on a chain that cannot fee-bump, exactly as with Retry Policy off (#9)', async () => {
    const { store, handler, coordinator, advance } = setup();
    const transactionId = await createPendingTransaction(store, true);
    advance(ABANDON_AFTER_MS);
    handler.getStatus.mockResolvedValue(ok('PENDING'));

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('ABANDONED');
  });

  it('still throws for a Transaction whose dispatchId references neither a Dispatch nor a RelayDispatch — a genuine data-integrity bug, never silently treated as a harmless RelayDispatch', async () => {
    const { store, handler, coordinator } = setup();
    const transaction = await store.createTransaction({
      dispatchId: 'orphaned-dispatch-id',
      callIndex: 0,
      chain: 'solana',
      signedBytes: 'signed-bytes',
      hash: 'hash-1',
    });
    handler.getStatus.mockResolvedValueOnce(ok('PENDING'));

    await expect(coordinator.pollPendingTransactions(10)).rejects.toThrow(
      /references unknown Dispatch/,
    );
    expect(store.getTransaction(transaction.id)?.status).toBe('PENDING'); // never silently abandoned
  });
});

describe('Coordinator fee-bump and rebroadcast of stuck transactions (#9, ADR-0037)', () => {
  async function createStuckCandidate(
    store: InMemoryDispatchStore,
    retryPolicy: boolean,
    items: DispatchItem<'base'>[] = [evmItem],
  ) {
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: `key-${Math.random()}`,
      items,
      retryPolicy,
    });
    const transactions = [];
    for (let callIndex = 0; callIndex < items.length; callIndex++) {
      transactions.push(
        await store.createTransaction({
          dispatchId: dispatch.id,
          callIndex,
          chain: 'base',
          signedBytes: 'signed-bytes',
          hash: 'hash-1',
        }),
      );
    }
    return { dispatch, transactions };
  }

  function currentVersions(store: InMemoryDispatchStore, dispatchId: string) {
    return store
      .listAllTransactions()
      .filter((t) => t.dispatchId === dispatchId)
      .map((t) => ({ hash: t.hash, status: t.status, feeBumpAttempts: t.feeBumpAttempts }));
  }

  it('leaves a transaction alone until it has been pending for stuckAfterMs', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    await createStuckCandidate(store, true);
    advance(STUCK_AFTER_MS - 1);

    await coordinator.pollPendingTransactions(10);

    expect((handler as BumpingFakeChainHandler).prepareReplacement).not.toHaveBeenCalled();
    expect(handler.broadcast).not.toHaveBeenCalled();
  });

  it('fee-bumps a stuck Managed Retry-Policy-on transaction into a new Transaction at the same nonce', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch } = await createStuckCandidate(store, true);
    advance(STUCK_AFTER_MS);
    handler.sign.mockResolvedValueOnce(ok('bumped-signed'));
    handler.broadcast.mockResolvedValueOnce(ok({ hash: 'hash-2' }));

    await coordinator.pollPendingTransactions(10);

    expect((handler as BumpingFakeChainHandler).prepareReplacement).toHaveBeenCalledWith(
      'signed-bytes',
      'sender-address',
    );
    expect(handler.broadcast).toHaveBeenCalledWith('bumped-signed');
    expect(currentVersions(store, dispatch.id)).toEqual([
      { hash: 'hash-1', status: 'REPLACED', feeBumpAttempts: 0 },
      { hash: 'hash-2', status: 'PENDING', feeBumpAttempts: 1 },
    ]);
  });

  it('rebroadcasts the identical bytes as a new Attempt when Retry Policy is off', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch, transactions } = await createStuckCandidate(store, false);
    advance(STUCK_AFTER_MS);

    await coordinator.pollPendingTransactions(10);

    expect((handler as BumpingFakeChainHandler).prepareReplacement).not.toHaveBeenCalled();
    expect(handler.broadcast).toHaveBeenCalledWith('signed-bytes');
    expect(currentVersions(store, dispatch.id)).toEqual([
      { hash: 'hash-1', status: 'PENDING', feeBumpAttempts: 0 },
    ]);
    expect(store.getTransaction(transactions[0]!.id)?.lastBroadcastAt).toEqual(
      new Date('2024-01-01T00:01:00.000Z'),
    );
  });

  it('rebroadcasts (never bumps) on an opted-in chain whose handler has no prepareReplacement', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling({ canBump: false });
    await createStuckCandidate(store, true);
    advance(STUCK_AFTER_MS);

    await coordinator.pollPendingTransactions(10);

    expect(handler.broadcast).toHaveBeenCalledWith('signed-bytes');
  });

  it('treats a failed rebroadcast (e.g. "already known") as harmless — still PENDING, polled again', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { transactions } = await createStuckCandidate(store, false);
    advance(STUCK_AFTER_MS);
    handler.broadcast.mockResolvedValueOnce(
      err({ code: 'CHAIN_REJECTED', message: 'already known' }),
    );

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transactions[0]!.id)?.status).toBe('PENDING');
  });

  it('restarts the stuck clock even when the rebroadcast is refused — never resends every tick (review of #9)', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    await createStuckCandidate(store, false);
    advance(STUCK_AFTER_MS);
    handler.broadcast.mockResolvedValue(err({ code: 'CHAIN_REJECTED', message: 'already known' }));

    await coordinator.pollPendingTransactions(10);
    advance(2_000);
    await coordinator.pollPendingTransactions(10);

    expect(handler.broadcast).toHaveBeenCalledTimes(1);
  });

  it('waits a full stuckAfterMs after a failed bump, even when the fallback rebroadcast is refused (review of #9)', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch } = await createStuckCandidate(store, true);
    (handler as BumpingFakeChainHandler).prepareReplacement.mockResolvedValue(
      err({ code: 'INSUFFICIENT_FUNDS', message: 'insufficient funds for gas * price + value' }),
    );
    handler.broadcast.mockResolvedValue(err({ code: 'CHAIN_REJECTED', message: 'already known' }));
    advance(STUCK_AFTER_MS);

    await coordinator.pollPendingTransactions(10);
    advance(2_000);
    await coordinator.pollPendingTransactions(10);

    expect((handler as BumpingFakeChainHandler).prepareReplacement).toHaveBeenCalledTimes(1);
    expect(currentVersions(store, dispatch.id)).toEqual([
      { hash: 'hash-1', status: 'PENDING', feeBumpAttempts: 1 },
    ]);
  });

  it('stops bumping when the replacement broadcast itself finds the nonce already used (review of #9)', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch } = await createStuckCandidate(store, true);
    handler.transactionHash.mockReturnValue(ok('hash-2'));
    handler.broadcast.mockResolvedValueOnce(
      err({ code: 'NONCE_ALREADY_USED', message: 'nonce too low' }),
    );
    advance(STUCK_AFTER_MS);

    await coordinator.pollPendingTransactions(10);

    // The refused replacement stays on record, undone (ADR-0041); the original is live, bumping stopped.
    expect(currentVersions(store, dispatch.id)).toEqual([
      { hash: 'hash-1', status: 'PENDING', feeBumpAttempts: MAX_FEE_BUMPS },
      { hash: 'hash-2', status: 'DROPPED', feeBumpAttempts: 1 },
    ]);
  });

  it('settles the Call on the original when it lands after being replaced — the replacement is DROPPED', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch } = await createStuckCandidate(store, true);
    advance(STUCK_AFTER_MS);
    handler.broadcast.mockResolvedValueOnce(ok({ hash: 'hash-2' }));
    await coordinator.pollPendingTransactions(10);

    handler.getStatus.mockImplementation((hash) =>
      Promise.resolve(ok(hash === 'hash-1' ? 'CONFIRMED' : 'PENDING')),
    );
    advance(1_000);
    await coordinator.pollPendingTransactions(10);

    expect(currentVersions(store, dispatch.id).map((v) => [v.hash, v.status])).toEqual([
      ['hash-1', 'CONFIRMED'],
      ['hash-2', 'DROPPED'],
    ]);
  });

  it('settles the Call on the replacement when it lands — the original is DROPPED', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch } = await createStuckCandidate(store, true);
    advance(STUCK_AFTER_MS);
    handler.broadcast.mockResolvedValueOnce(ok({ hash: 'hash-2' }));
    await coordinator.pollPendingTransactions(10);

    handler.getStatus.mockImplementation((hash) =>
      Promise.resolve(ok(hash === 'hash-2' ? 'CONFIRMED' : 'PENDING')),
    );
    advance(1_000);
    await coordinator.pollPendingTransactions(10);

    expect(currentVersions(store, dispatch.id).map((v) => [v.hash, v.status])).toEqual([
      ['hash-1', 'DROPPED'],
      ['hash-2', 'CONFIRMED'],
    ]);
  });

  it('stops bumping at maxFeeBumps, then rebroadcasts and abandons on the normal timeout', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch } = await createStuckCandidate(store, true);
    // Each bump signs distinct bytes; broadcasting given bytes always yields
    // that same hash, as on a real chain — so a rebroadcast keeps its hash.
    let nextSigned = 2;
    handler.sign.mockImplementation(() => Promise.resolve(ok(`signed-${nextSigned++}`)));
    handler.broadcast.mockImplementation((signed) =>
      Promise.resolve(
        ok({ hash: signed === 'signed-bytes' ? 'hash-1' : signed.replace('signed', 'hash') }),
      ),
    );

    for (let tick = 0; tick < MAX_FEE_BUMPS + 1; tick++) {
      advance(STUCK_AFTER_MS);
      await coordinator.pollPendingTransactions(10);
    }
    expect((handler as BumpingFakeChainHandler).prepareReplacement).toHaveBeenCalledTimes(
      MAX_FEE_BUMPS,
    );

    advance(ABANDON_AFTER_MS);
    await coordinator.pollPendingTransactions(10);

    const versions = currentVersions(store, dispatch.id);
    expect(versions).toHaveLength(MAX_FEE_BUMPS + 1);
    expect(versions.at(-1)?.status).toBe('ABANDONED');
  });

  it('undoes a replacement the node refused — the replacement DROPPED, the original PENDING again, the attempt counted (ADR-0041)', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch } = await createStuckCandidate(store, true);
    handler.transactionHash.mockReturnValue(ok('hash-2'));
    handler.broadcast.mockResolvedValueOnce(
      err({ code: 'CHAIN_REJECTED', message: 'replacement transaction underpriced' }),
    );
    advance(STUCK_AFTER_MS);

    await coordinator.pollPendingTransactions(10);

    expect(currentVersions(store, dispatch.id)).toEqual([
      { hash: 'hash-1', status: 'PENDING', feeBumpAttempts: 1 },
      { hash: 'hash-2', status: 'DROPPED', feeBumpAttempts: 1 },
    ]);
  });

  it('stops bumping for good once the nonce is already used, without creating a replacement', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch } = await createStuckCandidate(store, true);
    (handler as BumpingFakeChainHandler).prepareReplacement.mockResolvedValueOnce(
      err({ code: 'NONCE_ALREADY_USED', message: 'nonce 7 already consumed' }),
    );
    advance(STUCK_AFTER_MS);

    await coordinator.pollPendingTransactions(10);
    advance(STUCK_AFTER_MS);
    await coordinator.pollPendingTransactions(10);

    expect((handler as BumpingFakeChainHandler).prepareReplacement).toHaveBeenCalledTimes(1);
    expect(currentVersions(store, dispatch.id)).toEqual([
      { hash: 'hash-1', status: 'PENDING', feeBumpAttempts: MAX_FEE_BUMPS },
    ]);
  });

  it('counts a failed bump (e.g. insufficient funds) against the cap, rebroadcasts meanwhile, and tries again next time it is stuck', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch } = await createStuckCandidate(store, true);
    (handler as BumpingFakeChainHandler).prepareReplacement.mockResolvedValueOnce(
      err({ code: 'INSUFFICIENT_FUNDS', message: 'insufficient funds for gas * price + value' }),
    );
    advance(STUCK_AFTER_MS);

    await coordinator.pollPendingTransactions(10);

    expect(handler.broadcast).toHaveBeenCalledWith('signed-bytes');
    expect(currentVersions(store, dispatch.id)).toEqual([
      { hash: 'hash-1', status: 'PENDING', feeBumpAttempts: 1 },
    ]);

    handler.broadcast.mockResolvedValueOnce(ok({ hash: 'hash-2' }));
    advance(STUCK_AFTER_MS);
    await coordinator.pollPendingTransactions(10);

    expect(currentVersions(store, dispatch.id).at(-1)).toEqual({
      hash: 'hash-2',
      status: 'PENDING',
      feeBumpAttempts: 2,
    });
  });

  it('bumps a bundled broadcast once, fanning the replacement out to every member Call', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling();
    const { dispatch } = await createStuckCandidate(store, true, [evmItem, evmItem]);
    advance(STUCK_AFTER_MS);
    handler.broadcast.mockResolvedValueOnce(ok({ hash: 'hash-2' }));

    await coordinator.pollPendingTransactions(10);

    expect((handler as BumpingFakeChainHandler).prepareReplacement).toHaveBeenCalledTimes(1);
    expect(handler.broadcast).toHaveBeenCalledTimes(1);
    expect(
      store
        .listAllTransactions()
        .filter((t) => t.dispatchId === dispatch.id && t.status === 'PENDING')
        .map((t) => [t.callIndex, t.hash]),
    ).toEqual([
      [0, 'hash-2'],
      [1, 'hash-2'],
    ]);
  });

  it('resolves an ABANDONED fee-bumped Call through a REPLACED ancestor landing later', async () => {
    const { store, handler, coordinator, advance } = setupWithStuckHandling({ canBump: true });
    const { dispatch } = await createStuckCandidate(store, true);
    advance(STUCK_AFTER_MS);
    handler.broadcast.mockResolvedValueOnce(ok({ hash: 'hash-2' }));
    await coordinator.pollPendingTransactions(10);
    const [, replacement] = store.listAllTransactions().filter((t) => t.dispatchId === dispatch.id);
    await store.markAbandoned(replacement!.id);

    handler.getStatus.mockImplementation((hash) =>
      Promise.resolve(ok(hash === 'hash-1' ? 'CONFIRMED' : 'PENDING')),
    );
    await coordinator.rewatchAbandonedTransactions(10);

    expect(currentVersions(store, dispatch.id).map((v) => [v.hash, v.status])).toEqual([
      ['hash-1', 'CONFIRMED'],
      ['hash-2', 'DROPPED'],
    ]);
  });
});

/** A FakeChainHandler for a chain with Bulk Call (#11): per-slot outcomes from getBundleStatus. */
class BulkFakeChainHandler extends FakeChainHandler {
  getBundleStatus = vi.fn((_hash: string): Promise<Result<BundleSlotStatus[], DispatchError>> =>
    Promise.resolve(ok([])),
  );
}

describe('Coordinator Bulk Call (#11, ADR-0038)', () => {
  function setupBulk() {
    const store = new InMemoryDispatchStore();
    const handler = new BulkFakeChainHandler('base');
    const coordinator = new Coordinator({
      store,
      chainHandlers: new Map([['base', handler]]),
      senderAddresses: new Map([['base', 'sender-address']]),
      abandonmentTimeoutMs: new Map([['base', ABANDON_AFTER_MS]]),
      sleep: () => Promise.resolve(),
    });
    return { store, handler, coordinator };
  }
  const bulkCall = { aggregator: '0xaggregator', maxBatchSize: 50, allowFailure: true };

  it('prepares a Bulk Dispatch on its own with its bulkCall, apart from default-mode Dispatches in the same claim', async () => {
    const { store, handler, coordinator } = setupBulk();
    await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'plain',
      items: [evmItem],
      retryPolicy: false,
    });
    await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'bulk',
      items: [evmItem, evmItem],
      retryPolicy: false,
      bulkCall,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.prepare).toHaveBeenCalledTimes(2);
    expect(handler.prepare).toHaveBeenCalledWith([evmCall], 'sender-address');
    expect(handler.prepare).toHaveBeenCalledWith([evmCall, evmCall], 'sender-address', {
      bulkCall,
    });
  });

  it("checks an item funded by the aggregator against the aggregator's balance, not the Sender's", async () => {
    const { store, handler, coordinator } = setupBulk();
    handler.getBalance.mockImplementation((address, asset) =>
      Promise.resolve(ok({ asset, amount: address === '0xaggregator' ? '5' : '1000' })),
    );
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'bulk-funding',
      items: [
        {
          call: evmCall,
          payment: { recipient: '0xr', asset: 'USDC', amount: '10' },
          fundedBy: '0xaggregator',
        },
      ],
      retryPolicy: false,
      bulkCall,
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.getBalance).toHaveBeenCalledWith('0xaggregator', 'USDC');
    const [transaction] = await store.listTransactions(dispatch.id);
    expect(transaction?.error).toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      chainDetail: { asset: 'USDC', short: '5', fundedBy: '0xaggregator' },
    });
  });

  async function bundledPair(store: InMemoryDispatchStore, allowFailure = true) {
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: `bundle-${Math.random()}`,
      items: [evmItem, evmItem],
      retryPolicy: false,
      bulkCall: { ...bulkCall, allowFailure },
    });
    const rows = [];
    for (const callIndex of [0, 1]) {
      rows.push(
        await store.createTransaction({
          dispatchId: dispatch.id,
          callIndex,
          chain: 'base',
          signedBytes: 'bundle-bytes',
          hash: 'bundle-hash',
        }),
      );
    }
    return rows;
  }

  it('settles each bundled member from its own slot, so one failed item leaves its batch-mates confirmed', async () => {
    const { store, handler, coordinator } = setupBulk();
    const [first, second] = await bundledPair(store);
    handler.getBundleStatus.mockResolvedValue(
      ok([{ status: 'CONFIRMED' }, { status: 'FAILED', detail: { revert: '0x08c379a0' } }]),
    );

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(first!.id)?.status).toBe('CONFIRMED');
    const failed = store.getTransaction(second!.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error?.chainDetail).toMatchObject({ slot: 1, revert: '0x08c379a0' });
    expect(handler.getStatus).not.toHaveBeenCalled();
  });

  it('settles every member of an allowFailure: false bundle from the transaction itself — never traced (the default)', async () => {
    const { store, handler, coordinator } = setupBulk();
    const [first, second] = await bundledPair(store, false);
    handler.getStatus.mockResolvedValue(ok('FAILED')); // one bad item reverted the whole chunk

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(first!.id)?.status).toBe('FAILED');
    expect(store.getTransaction(second!.id)?.status).toBe('FAILED');
    expect(handler.getBundleStatus).not.toHaveBeenCalled();
  });

  it("leaves bundled members PENDING while the bundle is unresolved or its status can't be read", async () => {
    const { store, handler, coordinator } = setupBulk();
    const [first, second] = await bundledPair(store);
    handler.getBundleStatus.mockResolvedValueOnce(
      ok([{ status: 'PENDING' }, { status: 'PENDING' }]),
    );
    handler.getBundleStatus.mockResolvedValueOnce(
      err({ code: 'RPC_UNAVAILABLE', message: 'trace rpc down' }),
    );

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(first!.id)?.status).toBe('PENDING');
    expect(store.getTransaction(second!.id)?.status).toBe('PENDING');
  });
});

describe('Coordinator write-ahead: every Transaction is written down before it is sent (#20, ADR-0041)', () => {
  async function queueOne(
    store: InMemoryDispatchStore,
    items: DispatchItem<'solana'>[] = [solanaItem],
  ) {
    return store.createDispatch({
      chain: 'solana',
      idempotencyKey: `wa-${Math.random()}`,
      items,
      retryPolicy: false,
    });
  }

  it('saves the Transaction, under the locally computed hash, before calling broadcast', async () => {
    const { store, handler, coordinator } = setup();
    const dispatch = await queueOne(store);
    handler.transactionHash.mockReturnValue(ok('noted-hash'));
    handler.broadcast.mockImplementation(async () => {
      const [row] = await store.listTransactions(dispatch.id);
      expect(row).toMatchObject({
        status: 'PENDING',
        hash: 'noted-hash',
        signedBytes: 'signed-bytes',
      });
      return ok({ hash: 'noted-hash' });
    });

    await coordinator.processQueuedDispatches(10);

    expect(handler.broadcast).toHaveBeenCalledTimes(1);
  });

  it('leaves the Transaction PENDING, not FAILED, when the broadcast is ambiguous (e.g. a timeout)', async () => {
    const { store, handler, coordinator } = setup();
    const dispatch = await queueOne(store);
    handler.broadcast.mockResolvedValueOnce(err({ code: 'RPC_UNAVAILABLE', message: 'timed out' }));

    await coordinator.processQueuedDispatches(10);

    const [row] = await store.listTransactions(dispatch.id);
    expect(row).toMatchObject({ status: 'PENDING', hash: 'hash-1', error: null });
  });

  it('marks the Transaction FAILED when the node definitely refused it', async () => {
    const { store, handler, coordinator } = setup();
    const dispatch = await queueOne(store);
    handler.broadcast.mockResolvedValueOnce(
      err({ code: 'CHAIN_REJECTED', message: 'intrinsic gas too low' }),
    );

    await coordinator.processQueuedDispatches(10);

    const [row] = await store.listTransactions(dispatch.id);
    expect(row).toMatchObject({
      status: 'FAILED',
      error: { code: 'CHAIN_REJECTED', message: 'intrinsic gas too low' },
    });
  });

  it('takes the hash the chain reported if it differs from the noted one', async () => {
    const { store, handler, coordinator } = setup();
    const dispatch = await queueOne(store);
    handler.transactionHash.mockReturnValue(ok('noted-hash'));
    handler.broadcast.mockResolvedValueOnce(ok({ hash: 'refreshed-hash' }));

    await coordinator.processQueuedDispatches(10);

    const [row] = await store.listTransactions(dispatch.id);
    expect(row?.hash).toBe('refreshed-hash');
  });

  it('fails the Call without ever broadcasting when its hash cannot be computed', async () => {
    const { store, handler, coordinator } = setup();
    const dispatch = await queueOne(store);
    handler.transactionHash.mockReturnValueOnce(
      err({ code: 'CHAIN_REJECTED', message: 'undecodable' }),
    );

    await coordinator.processQueuedDispatches(10);

    expect(handler.broadcast).not.toHaveBeenCalled();
    const [row] = await store.listTransactions(dispatch.id);
    expect(row?.status).toBe('FAILED');
  });

  it("writes a Relay Dispatch's Transaction down (and links it) before broadcasting", async () => {
    const { store, handler, coordinator } = setup();
    const relay = await store.createRelayDispatch({
      chain: 'solana',
      idempotencyKey: `wa-r-${Math.random()}`,
      signedTransaction: 'relay-bytes',
    });
    handler.broadcast.mockImplementation(async () => {
      const [row] = await store.listTransactions(relay.id);
      expect(row?.status).toBe('PENDING');
      expect((await store.getRelayDispatch(relay.id))?.transactionId).toBe(row?.id);
      return ok({ hash: 'hash-1' });
    });

    await coordinator.processQueuedRelayDispatches(10);

    expect(handler.broadcast).toHaveBeenCalledTimes(1);
  });

  it('writes every member of a bundled broadcast down in one atomic step (#20 review)', async () => {
    const { store, handler, coordinator } = setup();
    await queueOne(store, [solanaItem, solanaItem]);
    handler.prepare.mockImplementation((items: Call[]) =>
      Promise.resolve(ok(items.map((_, callIndex) => ({ callIndex, unsignedTransaction: 'one-bundle' })))),
    );
    const createTransactions = vi.spyOn(store, 'createTransactions');

    await coordinator.processQueuedDispatches(10);

    expect(createTransactions).toHaveBeenCalledTimes(1);
    expect(createTransactions.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('never marks a Relay FAILED once any attempt was ambiguous — a later refusal may be "it already arrived" (#20 review)', async () => {
    const { store, handler, coordinator } = setup();
    handler.broadcast
      .mockResolvedValueOnce(err({ code: 'RPC_UNAVAILABLE', message: 'timed out' }))
      .mockResolvedValueOnce(err({ code: 'NONCE_ALREADY_USED', message: 'nonce too low' }));
    const relay = await store.createRelayDispatch({ chain: 'solana', idempotencyKey: `amb-${Math.random()}`, signedTransaction: 'relay-bytes' });

    await coordinator.processQueuedRelayDispatches(10);

    const [row] = await store.listTransactions(relay.id);
    expect(row?.status).toBe('PENDING');
  });

  it('treats ALREADY_KNOWN as ambiguous — the bytes are pooled, never FAILED (#20 review)', async () => {
    const { store, handler, coordinator } = setup();
    const dispatch = await queueOne(store);
    handler.broadcast.mockResolvedValueOnce(err({ code: 'ALREADY_KNOWN', message: 'already known' }));

    await coordinator.processQueuedDispatches(10);

    const [row] = await store.listTransactions(dispatch.id);
    expect(row?.status).toBe('PENDING');
  });

  it('hands every unsettled Transaction\'s signed bytes to the Chain Handler on restoreReservations (#20 review)', async () => {
    const { store, handler, coordinator } = setup();
    const reserve = vi.fn();
    (handler as FakeChainHandler & { restoreInFlight?: (signed: string[]) => void }).restoreInFlight = reserve;
    const dispatch = await queueOne(store, [solanaItem, solanaItem]);
    const pendingRow = await store.createTransaction({ dispatchId: dispatch.id, callIndex: 0, chain: 'solana', signedBytes: 'pending-bytes', hash: 'p' });
    const confirmedRow = await store.createTransaction({ dispatchId: dispatch.id, callIndex: 1, chain: 'solana', signedBytes: 'confirmed-bytes', hash: 'c' });
    await store.markConfirmed(confirmedRow.id);

    await coordinator.restoreReservations();

    expect(reserve).toHaveBeenCalledWith(['pending-bytes']);
    expect(pendingRow.id).toBeDefined();
  });

  describe('reclaiming stale claims', () => {
    function setupClocked() {
      let currentTime = new Date('2024-01-01T00:00:00.000Z');
      const clock = () => currentTime;
      const store = new InMemoryDispatchStore(clock);
      const handler = new FakeChainHandler('solana');
      const coordinator = new Coordinator({
        store,
        chainHandlers: new Map([['solana', handler]]),
        senderAddresses: new Map([['solana', 'sender-address']]),
        abandonmentTimeoutMs: new Map([['solana', ABANDON_AFTER_MS]]),
        now: clock,
        sleep: () => Promise.resolve(),
      });
      return {
        store,
        handler,
        coordinator,
        advance: (ms: number) => (currentTime = new Date(currentTime.getTime() + ms)),
      };
    }

    it('resumes only the never-sent items of a Dispatch whose claim went stale (a crash mid-batch)', async () => {
      const { store, handler, coordinator, advance } = setupClocked();
      const second: SolanaCall = { programId: 'prog-2', accounts: [], data: 'ZGF0YQ==' };
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'stale-1',
        items: [solanaItem, { call: second, payment: null }],
        retryPolicy: false,
      });
      await store.claimQueued(10); // the crashed worker's claim
      await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'b',
        hash: 'h0',
      });
      advance(5 * 60_000 + 1);

      await coordinator.reclaimStaleClaims(10);

      expect(handler.prepare).toHaveBeenCalledTimes(1);
      expect(handler.prepare).toHaveBeenCalledWith([second], 'sender-address');
      const rows = await store.listTransactions(dispatch.id);
      expect(rows.map((t) => t.callIndex).sort()).toEqual([0, 1]);
    });

    it('never reclaims a Dispatch this Coordinator is itself still processing — a slow batch is not a crash (#20 review)', async () => {
      const { store, handler, coordinator, advance } = setupClocked();
      await store.createDispatch({ chain: 'solana', idempotencyKey: 'slow-1', items: [solanaItem], retryPolicy: false });
      let reclaimDuringSend: Promise<void> | undefined;
      handler.sign.mockImplementationOnce(async () => {
        advance(5 * 60_000 + 1); // the batch is slow: its claim looks stale mid-flight
        reclaimDuringSend = coordinator.reclaimStaleClaims(10);
        await reclaimDuringSend;
        return ok('signed-bytes');
      });

      await coordinator.processQueuedDispatches(10);

      expect(handler.prepare).toHaveBeenCalledTimes(1); // reclaim never re-processed it
    });

    it('leaves a claim alone until it is 5 minutes stale', async () => {
      const { store, handler, coordinator, advance } = setupClocked();
      await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'stale-2',
        items: [solanaItem],
        retryPolicy: false,
      });
      await store.claimQueued(10);
      advance(5 * 60_000 - 1);

      await coordinator.reclaimStaleClaims(10);

      expect(handler.prepare).not.toHaveBeenCalled();
    });

    it('resumes a stale Relay Dispatch claim that never got a Transaction', async () => {
      const { store, handler, coordinator, advance } = setupClocked();
      const relay = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'stale-r',
        signedTransaction: 'relay-bytes',
      });
      await store.claimQueuedRelayDispatches(10);
      advance(5 * 60_000 + 1);

      await coordinator.reclaimStaleClaims(10);

      expect(handler.broadcast).toHaveBeenCalledWith('relay-bytes');
      expect((await store.getRelayDispatch(relay.id))?.transactionId).not.toBeNull();
    });
  });
});

describe('Coordinator.processQueuedRelayDispatches', () => {
  it('broadcasts a queued RelayDispatch exactly once — no validateCall/prepare/sign — and persists a PENDING Transaction', async () => {
    const { store, handler, coordinator } = setup();
    handler.broadcast.mockResolvedValueOnce(ok({ hash: 'relay-hash-1' }));
    const relayDispatch = await store.createRelayDispatch({
      chain: 'solana',
      idempotencyKey: 'relay-key-1',
      signedTransaction: 'externally-signed-bytes',
    });

    await coordinator.processQueuedRelayDispatches(10);

    expect(handler.validateCall).not.toHaveBeenCalled();
    expect(handler.prepare).not.toHaveBeenCalled();
    expect(handler.sign).not.toHaveBeenCalled();
    expect(handler.broadcast).toHaveBeenCalledTimes(1);
    expect(handler.broadcast).toHaveBeenCalledWith('externally-signed-bytes');

    const [transaction] = await store.listTransactions(relayDispatch.id);
    expect(transaction).toMatchObject({
      dispatchId: relayDispatch.id,
      callIndex: 0,
      status: 'PENDING',
      hash: 'relay-hash-1',
      signedBytes: 'externally-signed-bytes',
    });

    const updated = await store.getRelayDispatch(relayDispatch.id);
    expect(updated?.status).toBe('broadcasting');
    expect(updated?.transactionId).toBe(transaction?.id);
  });

  it('retries an identical-bytes broadcast on a transient RPC_UNAVAILABLE failure, succeeding on a later attempt', async () => {
    const { store, handler, coordinator } = setup();
    handler.broadcast
      .mockResolvedValueOnce(err({ code: 'RPC_UNAVAILABLE', message: 'timeout' }))
      .mockResolvedValueOnce(ok({ hash: 'relay-hash-2' }));
    const relayDispatch = await store.createRelayDispatch({
      chain: 'solana',
      idempotencyKey: 'relay-key-2',
      signedTransaction: 'externally-signed-bytes',
    });

    await coordinator.processQueuedRelayDispatches(10);

    expect(handler.broadcast).toHaveBeenCalledTimes(2);
    expect(handler.broadcast).toHaveBeenNthCalledWith(1, 'externally-signed-bytes');
    expect(handler.broadcast).toHaveBeenNthCalledWith(2, 'externally-signed-bytes');
    const [transaction] = await store.listTransactions(relayDispatch.id);
    expect(transaction).toMatchObject({ status: 'PENDING', hash: 'relay-hash-2' });
  });

  it('never retries a non-transient broadcast failure (e.g. CHAIN_REJECTED), and records it as a failed Transaction', async () => {
    const { store, handler, coordinator } = setup();
    handler.broadcast.mockResolvedValueOnce(
      err({ code: 'CHAIN_REJECTED', message: 'simulation failed' }),
    );
    const relayDispatch = await store.createRelayDispatch({
      chain: 'solana',
      idempotencyKey: 'relay-key-3',
      signedTransaction: 'externally-signed-bytes',
    });

    await coordinator.processQueuedRelayDispatches(10);

    expect(handler.broadcast).toHaveBeenCalledTimes(1);
    const [transaction] = await store.listTransactions(relayDispatch.id);
    // Written down before it was sent (ADR-0041), so its hash and bytes are on record too.
    expect(transaction).toMatchObject({
      status: 'FAILED',
      hash: 'hash-1',
      signedBytes: 'externally-signed-bytes',
      error: { code: 'CHAIN_REJECTED', message: 'simulation failed' },
    });
    const updated = await store.getRelayDispatch(relayDispatch.id);
    expect(updated?.transactionId).toBe(transaction?.id);
  });

  it('leaves a Relay Transaction PENDING — never falsely FAILED — once every bounded retry of a transient failure is exhausted (ADR-0041)', async () => {
    const { store, handler, coordinator } = setup();
    handler.broadcast.mockResolvedValue(err({ code: 'RPC_UNAVAILABLE', message: 'still down' }));
    const relayDispatch = await store.createRelayDispatch({
      chain: 'solana',
      idempotencyKey: 'relay-key-4',
      signedTransaction: 'externally-signed-bytes',
    });

    await coordinator.processQueuedRelayDispatches(10);

    expect(handler.broadcast).toHaveBeenCalledTimes(3); // RELAY_BROADCAST_MAX_ATTEMPTS
    const [transaction] = await store.listTransactions(relayDispatch.id);
    expect(transaction).toMatchObject({ status: 'PENDING', hash: 'hash-1', error: null }); // may have arrived: keep checking
  });

  it('processes each claimed RelayDispatch independently — one failing never blocks another', async () => {
    const { store, handler, coordinator } = setup();
    handler.broadcast
      .mockResolvedValueOnce(err({ code: 'CHAIN_REJECTED', message: 'rejected' }))
      .mockResolvedValueOnce(ok({ hash: 'relay-hash-5' }));
    const first = await store.createRelayDispatch({
      chain: 'solana',
      idempotencyKey: 'relay-key-5a',
      signedTransaction: 'bytes-a',
    });
    const second = await store.createRelayDispatch({
      chain: 'solana',
      idempotencyKey: 'relay-key-5b',
      signedTransaction: 'bytes-b',
    });

    await coordinator.processQueuedRelayDispatches(10);

    const [firstTransaction] = await store.listTransactions(first.id);
    const [secondTransaction] = await store.listTransactions(second.id);
    expect(firstTransaction?.status).toBe('FAILED');
    expect(secondTransaction?.status).toBe('PENDING');
  });
});

describe('Coordinator.pollPendingTransactions for a Relay Dispatch', () => {
  async function createPendingRelayTransaction(store: InMemoryDispatchStore): Promise<string> {
    const relayDispatch = await store.createRelayDispatch({
      chain: 'solana',
      idempotencyKey: `relay-poll-${Math.random()}`,
      signedTransaction: 'externally-signed-bytes',
    });
    const transaction = await store.createTransaction({
      dispatchId: relayDispatch.id,
      callIndex: 0,
      chain: 'solana',
      signedBytes: 'externally-signed-bytes',
      hash: 'relay-hash',
    });
    return transaction.id;
  }

  it('confirms a RelayDispatch-owned Transaction exactly like a Managed Dispatch one — pollPendingTransactions holds no Relay-Dispatch-specific branch', async () => {
    const { store, handler, coordinator } = setup();
    const transactionId = await createPendingRelayTransaction(store);
    handler.getStatus.mockResolvedValueOnce(ok('CONFIRMED'));

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('CONFIRMED');
  });

  it('abandons a RelayDispatch-owned Transaction once its chain-aware timeout elapses — Relay Dispatch has no retryPolicy to opt out with', async () => {
    const { store, handler, coordinator, advance } = setup();
    const transactionId = await createPendingRelayTransaction(store);
    advance(ABANDON_AFTER_MS);
    handler.getStatus.mockResolvedValue(ok('PENDING'));

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('ABANDONED');
  });
});

describe('Coordinator resubmission of provably expired transactions (ADR-0042)', () => {
  async function sendOne(items: DispatchItem<'solana'>[] = [solanaItem]) {
    const ctx = setup();
    const dispatch = await ctx.store.createDispatch({
      chain: 'solana',
      idempotencyKey: `exp-${Math.random()}`,
      items,
      retryPolicy: false,
    });
    await ctx.coordinator.processQueuedDispatches(10);
    ctx.handler.getStatus.mockImplementation((hash) =>
      Promise.resolve(ok(hash === 'hash-1' ? 'EXPIRED' : 'PENDING')),
    );
    ctx.handler.transactionHash.mockReturnValue(ok('hash-2'));
    ctx.handler.broadcast.mockResolvedValue(ok({ hash: 'hash-2' }));
    return { ...ctx, dispatch };
  }

  it('resubmits the Call as a new Transaction, written down before it is sent, and DROPs the dead original', async () => {
    const { store, handler, coordinator, dispatch } = await sendOne();
    handler.sign.mockResolvedValue(ok('resigned-bytes'));
    handler.broadcast.mockImplementation(async () => {
      const rows = await store.listTransactions(dispatch.id);
      expect(rows.find((t) => t.hash === 'hash-2')).toMatchObject({ status: 'PENDING', signedBytes: 'resigned-bytes' });
      return ok({ hash: 'hash-2' });
    });

    await coordinator.pollPendingTransactions(10);

    expect(handler.prepare).toHaveBeenLastCalledWith([solanaCall], 'sender-address');
    const rows = await store.listTransactions(dispatch.id);
    expect(rows.map((t) => [t.hash, t.status])).toEqual([
      ['hash-1', 'DROPPED'],
      ['hash-2', 'PENDING'],
    ]);
    expect(rows[1]?.replacesTransactionId).toBe(rows[0]?.id);
  });

  it('resubmits a bundle as one transaction for all its members', async () => {
    const { store, handler, coordinator, dispatch } = await sendOne([solanaItem, solanaItem]);
    handler.prepare.mockImplementation((items: Call[]) =>
      Promise.resolve(ok(items.map((_, callIndex) => ({ callIndex, unsignedTransaction: 'bundle' })))),
    );
    handler.sign.mockClear();
    handler.broadcast.mockClear();

    await coordinator.pollPendingTransactions(10);

    expect(handler.prepare).toHaveBeenLastCalledWith([solanaCall, solanaCall], 'sender-address');
    expect(handler.sign).toHaveBeenCalledTimes(1);
    expect(handler.broadcast).toHaveBeenCalledTimes(1);
    const live = (await store.listTransactions(dispatch.id)).filter((t) => t.status === 'PENDING');
    expect(live.map((t) => [t.callIndex, t.hash])).toEqual([
      [0, 'hash-2'],
      [1, 'hash-2'],
    ]);
  });

  it('fails the Call once it has been resubmitted 3 times', async () => {
    const { store, handler, coordinator, dispatch } = await sendOne();
    let n = 1;
    handler.getStatus.mockResolvedValue(ok('EXPIRED'));
    handler.transactionHash.mockImplementation(() => ok(`hash-${++n}`));
    handler.broadcast.mockImplementation(() => Promise.resolve(ok({ hash: `hash-${n}` })));

    for (let tick = 0; tick < 4; tick++) await coordinator.pollPendingTransactions(10);

    const rows = await store.listTransactions(dispatch.id);
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)).toMatchObject({ status: 'FAILED', error: { code: 'CHAIN_REJECTED' } });
    expect(rows.slice(0, 3).every((t) => t.status === 'DROPPED')).toBe(true);
  });

  it('fails an expired Relay Dispatch — there is no key to re-sign it', async () => {
    const { store, handler, coordinator } = setup();
    const relay = await store.createRelayDispatch({ chain: 'solana', idempotencyKey: `exp-r-${Math.random()}`, signedTransaction: 'relay-bytes' });
    await coordinator.processQueuedRelayDispatches(10);
    handler.getStatus.mockResolvedValue(ok('EXPIRED'));
    handler.sign.mockClear();

    await coordinator.pollPendingTransactions(10);

    expect(handler.sign).not.toHaveBeenCalled();
    const [row] = await store.listTransactions(relay.id);
    expect(row).toMatchObject({ status: 'FAILED', error: { code: 'CHAIN_REJECTED' } });
  });

  it('leaves the expired Transaction PENDING when re-signing fails, and retries next tick', async () => {
    const { store, handler, coordinator, dispatch } = await sendOne();
    handler.sign.mockResolvedValueOnce(err({ code: 'SIGNER_UNREACHABLE', message: 'down' }));

    await coordinator.pollPendingTransactions(10);
    expect((await store.listTransactions(dispatch.id)).map((t) => t.status)).toEqual(['PENDING']);

    await coordinator.pollPendingTransactions(10);
    expect((await store.listTransactions(dispatch.id)).map((t) => t.status)).toEqual(['DROPPED', 'PENDING']);
  });

  it('marks the resubmission FAILED when the node definitely refuses it', async () => {
    const { store, handler, coordinator, dispatch } = await sendOne();
    handler.broadcast.mockResolvedValue(err({ code: 'INSUFFICIENT_FUNDS', message: 'insufficient lamports' }));

    await coordinator.pollPendingTransactions(10);

    expect((await store.listTransactions(dispatch.id)).map((t) => t.status)).toEqual(['DROPPED', 'FAILED']);
  });
});

describe('Coordinator.rewatchAbandonedTransactions', () => {
  async function createAbandonedTransaction(store: InMemoryDispatchStore): Promise<string> {
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: `key-${Math.random()}`,
      items: [solanaItem],
      retryPolicy: false,
    });
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'solana',
      signedBytes: 'signed-bytes',
      hash: 'hash-1',
    });
    await store.markAbandoned(transaction.id);
    return transaction.id;
  }

  it('confirms a previously-ABANDONED Transaction that turns out to have landed after all', async () => {
    const { store, handler, coordinator } = setup();
    const transactionId = await createAbandonedTransaction(store);
    handler.getStatus.mockResolvedValueOnce(ok('CONFIRMED'));

    await coordinator.rewatchAbandonedTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('CONFIRMED');
  });

  it('fails a previously-ABANDONED Transaction that the chain now reports as FAILED', async () => {
    const { store, handler, coordinator } = setup();
    const transactionId = await createAbandonedTransaction(store);
    handler.getStatus.mockResolvedValueOnce(ok('FAILED'));

    await coordinator.rewatchAbandonedTransactions(10);

    const transaction = store.getTransaction(transactionId);
    expect(transaction?.status).toBe('FAILED');
    expect(transaction?.error?.code).toBe('CHAIN_REJECTED');
  });

  it('fails a previously-ABANDONED Transaction that provably expired — too late to resubmit (ADR-0042)', async () => {
    const { store, handler, coordinator } = setup();
    const transactionId = await createAbandonedTransaction(store);
    handler.getStatus.mockResolvedValueOnce(ok('EXPIRED'));

    await coordinator.rewatchAbandonedTransactions(10);

    expect(store.getTransaction(transactionId)).toMatchObject({ status: 'FAILED', error: { code: 'CHAIN_REJECTED' } });
  });

  it('leaves a Transaction ABANDONED when the chain still reports it as PENDING', async () => {
    const { store, handler, coordinator } = setup();
    const transactionId = await createAbandonedTransaction(store);
    handler.getStatus.mockResolvedValueOnce(ok('PENDING'));

    await coordinator.rewatchAbandonedTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('ABANDONED');
  });

  it('leaves a Transaction ABANDONED when getStatus itself fails', async () => {
    const { store, handler, coordinator } = setup();
    const transactionId = await createAbandonedTransaction(store);
    handler.getStatus.mockResolvedValueOnce(err({ code: 'RPC_UNAVAILABLE', message: 'rpc down' }));

    await coordinator.rewatchAbandonedTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('ABANDONED');
  });

  it('never re-checks a Transaction abandoned before the bounded re-watch window', async () => {
    const { store, handler, coordinator, advance } = setup();
    const transactionId = await createAbandonedTransaction(store);
    advance(25 * 60 * 60 * 1000); // past the default 24h re-watch window
    handler.getStatus.mockResolvedValueOnce(ok('CONFIRMED'));

    await coordinator.rewatchAbandonedTransactions(10);

    expect(handler.getStatus).not.toHaveBeenCalled();
    expect(store.getTransaction(transactionId)?.status).toBe('ABANDONED');
  });

  it('respects the limit parameter', async () => {
    const { store, handler, coordinator } = setup();
    await createAbandonedTransaction(store);
    await createAbandonedTransaction(store);
    handler.getStatus.mockResolvedValue(ok('CONFIRMED'));

    await coordinator.rewatchAbandonedTransactions(1);

    expect(handler.getStatus).toHaveBeenCalledTimes(1);
  });
});

describe('Coordinator.recheckRecentlyConfirmedTransactions (base-chain-handler issue 07)', () => {
  async function createConfirmedTransaction(store: InMemoryDispatchStore): Promise<string> {
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: `key-${Math.random()}`,
      items: [solanaItem],
      retryPolicy: false,
    });
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'solana',
      signedBytes: 'signed-bytes',
      hash: 'hash-1',
    });
    await store.markConfirmed(transaction.id);
    return transaction.id;
  }

  it('does nothing when no chain has opted into reorgRecheckWindowMs', async () => {
    const { store, handler, coordinator } = setup(); // plain setup(): no reorgRecheckWindowMs at all
    const transactionId = await createConfirmedTransaction(store);

    await coordinator.recheckRecentlyConfirmedTransactions(10);

    expect(handler.getStatus).not.toHaveBeenCalled();
    expect(store.getTransaction(transactionId)?.status).toBe('CONFIRMED');
  });

  it('leaves a Transaction CONFIRMED when the chain still reports it as CONFIRMED', async () => {
    const { store, handler, coordinator } = setupWithReorgRecheck();
    const transactionId = await createConfirmedTransaction(store);
    handler.getStatus.mockResolvedValueOnce(ok('CONFIRMED'));

    await coordinator.recheckRecentlyConfirmedTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('CONFIRMED');
  });

  it('reopens a Transaction back to PENDING when the chain no longer finds its receipt (a reorg)', async () => {
    const { store, handler, coordinator } = setupWithReorgRecheck();
    const transactionId = await createConfirmedTransaction(store);
    handler.getStatus.mockResolvedValueOnce(ok('PENDING'));

    await coordinator.recheckRecentlyConfirmedTransactions(10);

    const transaction = store.getTransaction(transactionId);
    expect(transaction?.status).toBe('PENDING');
    expect(transaction?.confirmedAt).toBeNull();
  });

  it('marks a Transaction FAILED when the chain reports it failed on re-check', async () => {
    const { store, handler, coordinator } = setupWithReorgRecheck();
    const transactionId = await createConfirmedTransaction(store);
    handler.getStatus.mockResolvedValueOnce(ok('FAILED'));

    await coordinator.recheckRecentlyConfirmedTransactions(10);

    const transaction = store.getTransaction(transactionId);
    expect(transaction?.status).toBe('FAILED');
    expect(transaction?.error?.code).toBe('CHAIN_REJECTED');
  });

  it('leaves a Transaction CONFIRMED when the re-check status call itself fails', async () => {
    const { store, handler, coordinator } = setupWithReorgRecheck();
    const transactionId = await createConfirmedTransaction(store);
    handler.getStatus.mockResolvedValueOnce(err({ code: 'RPC_UNAVAILABLE', message: 'rpc down' }));

    await coordinator.recheckRecentlyConfirmedTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('CONFIRMED');
  });

  it('never re-checks a Transaction confirmed before the bounded re-check window', async () => {
    const { store, handler, coordinator, advance } = setupWithReorgRecheck();
    const transactionId = await createConfirmedTransaction(store);
    advance(RECHECK_WINDOW_MS + 60_000); // past the configured window
    handler.getStatus.mockResolvedValueOnce(ok('PENDING'));

    await coordinator.recheckRecentlyConfirmedTransactions(10);

    expect(handler.getStatus).not.toHaveBeenCalled();
    expect(store.getTransaction(transactionId)?.status).toBe('CONFIRMED');
  });

  it('never touches a chain absent from reorgRecheckWindowMs, even with other chains configured', async () => {
    const currentTime = new Date('2024-01-01T00:00:00.000Z');
    const clock = () => currentTime;
    const store = new InMemoryDispatchStore(clock);
    const solanaHandler = new FakeChainHandler('solana');
    const baseHandler = new FakeChainHandler('base');
    const coordinator = new Coordinator({
      store,
      chainHandlers: new Map([
        ['solana', solanaHandler],
        ['base', baseHandler],
      ]),
      senderAddresses: new Map([
        ['solana', 'sender-address'],
        ['base', 'sender-address'],
      ]),
      abandonmentTimeoutMs: new Map([
        ['solana', ABANDON_AFTER_MS],
        ['base', ABANDON_AFTER_MS],
      ]),
      reorgRecheckWindowMs: new Map([['base', RECHECK_WINDOW_MS]]), // solana opts out
      now: clock,
    });

    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'solana-not-opted-in',
      items: [solanaItem],
      retryPolicy: false,
    });
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'solana',
      signedBytes: 'signed-bytes',
      hash: 'hash-1',
    });
    await store.markConfirmed(transaction.id);

    await coordinator.recheckRecentlyConfirmedTransactions(10);

    expect(solanaHandler.getStatus).not.toHaveBeenCalled();
    expect(store.getTransaction(transaction.id)?.status).toBe('CONFIRMED');
  });

  it('never delays or gates the initial CONFIRMED report — markConfirmed happens directly in the main poll path, with no dependency on this method at all', async () => {
    const { store, handler, coordinator } = setupWithReorgRecheck();
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'initial-confirm',
      items: [solanaItem],
      retryPolicy: false,
    });
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'solana',
      signedBytes: 'signed-bytes',
      hash: 'hash-1',
    });
    handler.getStatus.mockResolvedValueOnce(ok('CONFIRMED'));

    // pollPendingTransactions (the main path) never calls recheckRecentlyConfirmedTransactions.
    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transaction.id)?.status).toBe('CONFIRMED');
    expect(handler.getStatus).toHaveBeenCalledTimes(1);
  });
});
