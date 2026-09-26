import { createPublicClient, http, parseTransaction, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Coordinator } from '../../coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { BASE_ABANDONMENT_TIMEOUT_MS, BaseChainHandler } from './base-chain-handler.js';
import {
  acquireDevSenderLock,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  DEV_SENDER_LOCK_HOOK_TIMEOUT_MS,
  getDevSenderAccount,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/base-fixtures.js';

const STUCK_AFTER_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * #20 (ADR-0041), against real Base Sepolia (ADR-0013): a transaction is
 * written down before it is sent, so neither a crash nor an ambiguous
 * failure can lose track of one that may land. "Restart" here is a fresh
 * BaseChainHandler and Coordinator over the same stores — exactly what a
 * restarted worker has.
 */
describe('Base write-ahead crash recovery (#20, real Base Sepolia)', () => {
  const sender = getDevSenderAccount();
  const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
  let testSigner: TestSignerHandle;
  let releaseDevSenderLock: () => Promise<void>;

  beforeAll(async () => {
    releaseDevSenderLock = await acquireDevSenderLock();
    testSigner = await startTestSigner([sender]);
  }, DEV_SENDER_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await testSigner?.close();
    await releaseDevSenderLock?.();
  });

  function createHandler(nonceHistoryStore: InMemoryNonceHistoryStore, fetchFn?: typeof fetch) {
    return BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      signerClient: new SignerClient(testSigner.url),
      nonceHistoryStore,
      ...(fetchFn ? { fetch: fetchFn } : {}),
    });
  }

  function coordinatorFor(
    store: InMemoryDispatchStore,
    handler: BaseChainHandler,
    now?: () => Date,
  ) {
    return new Coordinator({
      store,
      chainHandlers: new Map([['base', handler]]),
      senderAddresses: new Map([['base', sender.address]]),
      abandonmentTimeoutMs: new Map([['base', BASE_ABANDONMENT_TIMEOUT_MS]]),
      stuckHandling: new Map([['base', { stuckAfterMs: STUCK_AFTER_MS, maxFeeBumps: 3 }]]),
      ...(now ? { now } : {}),
    });
  }

  async function pollUntilSettled(
    coordinator: Coordinator,
    store: InMemoryDispatchStore,
    ids: string[],
  ) {
    const deadline = Date.now() + 90_000;
    for (;;) {
      await coordinator.pollPendingTransactions(20);
      const rows = store.listAllTransactions().filter((t) => ids.includes(t.id));
      if (rows.every((t) => t.status !== 'PENDING') || Date.now() > deadline) return rows;
      await sleep(2_000);
    }
  }

  const payment = () => ({
    call: { to: privateKeyToAddress(generatePrivateKey()), data: '0x', value: '1000' },
    payment: null,
  });

  it('a crash between writing a Transaction down and sending it: after restart it is sent, lands once, and the next payment takes the next nonce', async () => {
    const store = new InMemoryDispatchStore();
    const nonceHistory = new InMemoryNonceHistoryStore();

    // The worker that "dies": its broadcast never reaches the chain.
    const doomed = await createHandler(nonceHistory);
    doomed.broadcast = () => Promise.reject(new Error('process died before the send'));
    const first = await store.createDispatch({
      chain: 'base',
      idempotencyKey: `crash-${Date.now()}`,
      items: [payment()],
      retryPolicy: false,
    });
    await expect(coordinatorFor(store, doomed).processQueuedDispatches(10)).rejects.toThrow(
      /process died/,
    );
    const [noted] = await store.listTransactions(first.id);
    expect(noted).toMatchObject({ status: 'PENDING' }); // written down, never sent
    const notedNonce = parseTransaction(noted!.signedBytes as Hex).nonce!;
    expect(
      await client.getTransactionReceipt({ hash: noted!.hash as Hex }).catch(() => null),
    ).toBeNull();

    // Restart: a fresh handler and Coordinator over the same stores.
    const restarted = await createHandler(nonceHistory);
    expect(restarted.peekNextNonce()).toBe(notedNonce + 1); // the noted nonce stays reserved for its recovery
    const coordinator = coordinatorFor(store, restarted);
    const second = await store.createDispatch({
      chain: 'base',
      idempotencyKey: `after-restart-${Date.now()}`,
      items: [payment()],
      retryPolicy: false,
    });
    await coordinator.processQueuedDispatches(10);
    const [next] = await store.listTransactions(second.id);
    expect(parseTransaction(next!.signedBytes as Hex).nonce).toBe(notedNonce + 1);

    await sleep(STUCK_AFTER_MS + 1_000); // the noted transaction is now "stuck": rebroadcast = its first real send
    const settled = await pollUntilSettled(coordinator, store, [noted!.id, next!.id]);

    expect(settled.map((t) => t.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect((await client.getTransaction({ hash: noted!.hash as Hex })).nonce).toBe(notedNonce);
  }, 180_000);

  it('a send that reaches the node but times out is left PENDING — never falsely FAILED — and confirms', async () => {
    const store = new InMemoryDispatchStore();
    // Lets eth_sendRawTransaction reach the node, then reports a timeout.
    const timesOutAfterSending: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (typeof init?.body === 'string' && init.body.includes('eth_sendRawTransaction')) {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return response;
    };
    const handler = await createHandler(new InMemoryNonceHistoryStore(), timesOutAfterSending);
    const coordinator = coordinatorFor(store, handler);
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: `timeout-${Date.now()}`,
      items: [payment()],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    const [row] = await store.listTransactions(dispatch.id);
    expect(row).toMatchObject({ status: 'PENDING', error: null });
    const [settled] = await pollUntilSettled(coordinator, store, [row!.id]);
    expect(settled?.status).toBe('CONFIRMED');
  }, 180_000);

  it('a claim left half-done by a crash is reclaimed after 5 minutes, and its never-sent item lands', async () => {
    let currentTime = new Date();
    const clock = () => currentTime;
    const store = new InMemoryDispatchStore(clock);
    const handler = await createHandler(new InMemoryNonceHistoryStore());
    const coordinator = coordinatorFor(store, handler, clock);
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: `stale-claim-${Date.now()}`,
      items: [payment()],
      retryPolicy: false,
    });
    await store.claimQueued(10); // the crashed worker's claim: nothing was ever sent

    currentTime = new Date(currentTime.getTime() + 5 * 60_000 + 1);
    await coordinator.reclaimStaleClaims(10);

    const [row] = await store.listTransactions(dispatch.id);
    expect(row?.status).toBe('PENDING');
    currentTime = new Date(); // back to real time, so the stuck timer doesn't fire on a fresh send
    const [settled] = await pollUntilSettled(coordinator, store, [row!.id]);
    expect(settled?.status).toBe('CONFIRMED');
  }, 180_000);
});
