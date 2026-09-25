import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Coordinator } from '../../coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { BASE_REORG_RECHECK_WINDOW_MS, BaseChainHandler } from './base-chain-handler.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  acquireDevSenderLock,
  getDevSenderAccount,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/base-fixtures.js';

/**
 * issue 07: the reorg safety net, proven with a synthetic/forced scenario
 * against real BaseChainHandler.getStatus — Base reorgs are documented as
 * vanishingly rare (research-base.md §4: "Only a single Base L2 block has
 * ever reorged"), so this ticket explicitly doesn't need a real one, "same
 * spirit as how issue 09's fee-bump test forces a stuck-transaction
 * scenario rather than waiting for one to occur naturally."
 *
 * The synthetic setup: a Transaction row the store believes is CONFIRMED,
 * but whose hash never actually landed on Base Sepolia — exactly what a
 * reorg leaves behind (a hash this engine once saw a receipt for, now
 * gone). The re-check itself is entirely real: a genuine
 * eth_getTransactionReceipt call via the real handler, genuinely finding
 * no receipt.
 *
 * The initial CONFIRMED report's own timing (not delayed/gated by any of
 * this) is proven in status.test.ts ("reports CONFIRMED within roughly
 * Base's ~2s inclusion window") and structurally in coordinator.test.ts
 * ("never delays or gates the initial CONFIRMED report") — recheck is a
 * wholly separate method the main poll path never calls.
 */
describe('Base reorg safety net (issue 07, real Base Sepolia getStatus, synthetic reorg)', () => {
  let testSigner: TestSignerHandle;
  let handler: BaseChainHandler;
  let releaseDevSenderLock: () => Promise<void>;

  beforeAll(async () => {
    releaseDevSenderLock = await acquireDevSenderLock();
    const sender = getDevSenderAccount();
    testSigner = await startTestSigner([sender]);
    handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      signerClient: new SignerClient(testSigner.url),
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });
  }, 120_000);

  afterAll(async () => {
    await testSigner?.close();
    await releaseDevSenderLock?.();
  });

  function newCoordinator(store: InMemoryDispatchStore, senderAddress: string): Coordinator {
    return new Coordinator({
      store,
      chainHandlers: new Map([['base', handler]]),
      senderAddresses: new Map([['base', senderAddress]]),
      abandonmentTimeoutMs: new Map([['base', 15 * 60_000]]),
      reorgRecheckWindowMs: new Map([['base', BASE_REORG_RECHECK_WINDOW_MS]]),
    });
  }

  it('reopens a Transaction the store believes is CONFIRMED once the real chain no longer has its receipt', async () => {
    const sender = getDevSenderAccount();
    const store = new InMemoryDispatchStore();
    const coordinator = newCoordinator(store, sender.address);

    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'issue-07-synthetic-reorg-test',
      items: [{ call: { to: sender.address, data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    // A real-shaped hash that never actually landed — exactly what's left
    // once a (vanishingly rare) reorg drops a transaction this engine had
    // already recorded a receipt for.
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: 'irrelevant-to-this-test',
      hash: '0x0000000000000000000000000000000000000000000000000000000000000003',
    });
    await store.markConfirmed(transaction.id);
    expect(store.getTransaction(transaction.id)?.status).toBe('CONFIRMED');

    await coordinator.recheckRecentlyConfirmedTransactions(10);

    const reopened = store.getTransaction(transaction.id);
    expect(reopened?.status).toBe('PENDING');
    expect(reopened?.confirmedAt).toBeNull();
  }, 30_000);

  it('leaves a genuinely still-confirmed Transaction alone on re-check', async () => {
    const sender = getDevSenderAccount();
    const realHash = await broadcastAndConfirmOnce(handler, sender.address);

    const store = new InMemoryDispatchStore();
    const coordinator = newCoordinator(store, sender.address);
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'issue-07-still-confirmed-test',
      items: [{ call: { to: sender.address, data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: 'irrelevant-to-this-test',
      hash: realHash,
    });
    await store.markConfirmed(transaction.id);

    await coordinator.recheckRecentlyConfirmedTransactions(10);

    const stillConfirmed = store.getTransaction(transaction.id);
    expect(stillConfirmed?.status).toBe('CONFIRMED');
    expect(stillConfirmed?.confirmedAt).not.toBeNull();
  }, 60_000);
});

async function broadcastAndConfirmOnce(
  handler: BaseChainHandler,
  senderAddress: string,
): Promise<string> {
  const callResult = await handler.paymentToCall({
    recipient: senderAddress,
    asset: 'ETH',
    amount: '0',
  });
  if (!callResult.ok) throw new Error('paymentToCall failed');
  const prepareResult = await handler.prepare([callResult.value], senderAddress);
  if (!prepareResult.ok) throw new Error('prepare failed');
  const prepared = prepareResult.value[0];
  if (!prepared) throw new Error('no PreparedTransaction');
  const signResult = await handler.sign(prepared, senderAddress);
  if (!signResult.ok) throw new Error('sign failed');
  const broadcastResult = await handler.broadcast(signResult.value);
  if (!broadcastResult.ok) throw new Error('broadcast failed');

  const deadline = Date.now() + 30_000;
  let status = await handler.getStatus(broadcastResult.value.hash);
  while (status.ok && status.value === 'PENDING' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    status = await handler.getStatus(broadcastResult.value.hash);
  }
  return broadcastResult.value.hash;
}
