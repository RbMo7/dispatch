import { describe, expect, it, vi } from 'vitest';

import type {
  Balance,
  BroadcastResult,
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
const evmItem: DispatchItem<'evm'> = { call: evmCall, payment: null };

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
      chain: 'evm',
      idempotencyKey: 'key-1',
      items: [evmItem],
      retryPolicy: false,
    });

    await expect(coordinator.processQueuedDispatches(10)).rejects.toThrow(
      /No ChainHandler registered/,
    );
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

  it('never abandons a still-PENDING Transaction once Retry Policy is on, no matter how long it has waited', async () => {
    const { store, handler, coordinator, advance } = setup();
    const transactionId = await createPendingTransaction(store, true);
    advance(ABANDON_AFTER_MS * 10);
    handler.getStatus.mockResolvedValue(ok('PENDING'));

    await coordinator.pollPendingTransactions(10);

    expect(store.getTransaction(transactionId)?.status).toBe('PENDING');
  });
});
