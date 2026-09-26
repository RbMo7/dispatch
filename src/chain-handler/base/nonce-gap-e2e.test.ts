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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * #24 (ADR-0039), against real Base Sepolia (ADR-0013): a send that fails
 * must never leave a nonce gap that strands the Sender's later
 * transactions. The first two cases never broadcast; the last reproduces
 * the ticket exactly and lands one real transaction.
 */
describe('Base nonce gaps (#24, real Base Sepolia)', () => {
  const sender = getDevSenderAccount();
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

  function createHandler(signerUrl: string) {
    return BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      signerClient: new SignerClient(signerUrl),
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });
  }

  it('prepare hands out no nonces — a batch whose prepare fails can leave no gap', async () => {
    const handler = await createHandler(testSigner.url);
    const before = handler.peekNextNonce();

    const prepared = await handler.prepare(
      [
        { to: sender.address, data: '0x', value: '0' },
        { to: sender.address, data: '0x', value: '0' },
      ],
      sender.address,
    );

    expect(prepared.ok).toBe(true);
    expect(handler.peekNextNonce()).toBe(before);
    // Identical payments must still be distinct transactions, never one bundle.
    expect(prepared.ok && prepared.value[0]?.unsignedTransaction).not.toBe(
      prepared.ok && prepared.value[1]?.unsignedTransaction,
    );
  }, 60_000);

  it('a sign that fails hands its nonce straight back', async () => {
    const handler = await createHandler('http://127.0.0.1:1'); // nothing listens: the Signer is unreachable
    const before = handler.peekNextNonce();
    const prepared = await handler.prepare(
      [{ to: sender.address, data: '0x', value: '0' }],
      sender.address,
    );
    if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');

    const signed = await handler.sign(prepared.value[0], sender.address);

    expect(signed.ok).toBe(false);
    expect(handler.peekNextNonce()).toBe(before);
  }, 60_000);

  it('a refused broadcast mid-batch never strands the next Call: it takes the released nonce and confirms', async () => {
    const handler = await createHandler(testSigner.url);
    const store = new InMemoryDispatchStore();
    const coordinator = new Coordinator({
      store,
      chainHandlers: new Map([['base', handler]]),
      senderAddresses: new Map([['base', sender.address]]),
      abandonmentTimeoutMs: new Map([['base', BASE_ABANDONMENT_TIMEOUT_MS]]),
    });
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: `nonce-gap-${Date.now()}`,
      items: [
        // More ETH than the Sender has: the node refuses it at broadcast.
        {
          call: {
            to: privateKeyToAddress(generatePrivateKey()),
            data: '0x',
            value: (10n ** 30n).toString(),
          },
          payment: null,
        },
        {
          call: { to: privateKeyToAddress(generatePrivateKey()), data: '0x', value: '1000' },
          payment: null,
        },
      ],
      retryPolicy: false,
    });

    await coordinator.processQueuedDispatches(10);

    const [refused, next] = await store.listTransactions(dispatch.id);
    expect(refused?.status).toBe('FAILED');
    expect(refused?.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect(next?.hash).toEqual(expect.any(String));

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && store.getTransaction(next!.id)?.status === 'PENDING') {
      await coordinator.pollPendingTransactions(10);
      await sleep(1_500);
    }
    expect(store.getTransaction(next!.id)?.status).toBe('CONFIRMED');
  }, 120_000);
});
