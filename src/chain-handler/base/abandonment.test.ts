import { describe, expect, it } from 'vitest';

import { Coordinator } from '../../coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { BASE_ABANDONMENT_TIMEOUT_MS, BaseChainHandler } from './base-chain-handler.js';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_RPC_URL, getDevSenderAccount } from './test-support/base-fixtures.js';

/**
 * issue 08: a Base transaction whose getStatus keeps returning PENDING past
 * the Coordinator's existing chain-agnostic abandonment timeout (ADR-0004)
 * is marked ABANDONED — with zero new Base-specific timeout logic added
 * anywhere in this handler (getStatus, issue 06, is exactly the same code
 * whether or not a hash ever confirms). This is genuinely, honestly PENDING
 * via a real eth_getTransactionReceipt call against a hash that will never
 * exist (ADR-0013) — not a stubbed handler standing in for one.
 *
 * The higher-nonce-confirmed proof that would resolve some of these to
 * FAILED instead (the deferred EVM analogue of ADR-0030) is explicitly not
 * built here — confirmed by this test, which never touches nonce history
 * at all and still lands on ABANDONED.
 */
describe('Base ABANDONED timeout (issue 08, real Base Sepolia getStatus)', () => {
  it('marks a Base transaction ABANDONED — distinct from FAILED — once past the timeout, using the Coordinator\'s existing generic mechanism unchanged', async () => {
    const sender = getDevSenderAccount();
    const handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });

    const store = new InMemoryDispatchStore();
    let currentTime = new Date();
    const coordinator = new Coordinator({
      store,
      chainHandlers: new Map([['base', handler]]),
      senderAddresses: new Map([['base', sender.address]]),
      abandonmentTimeoutMs: new Map([['base', BASE_ABANDONMENT_TIMEOUT_MS]]),
      now: () => currentTime,
    });

    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'issue-08-abandonment-test',
      items: [{ call: { to: sender.address, data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    // A real-shaped, real-network hash that will never exist on-chain —
    // getStatus reports PENDING for it via a genuine (always-404) RPC call.
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: 'irrelevant-to-this-test',
      hash: '0x0000000000000000000000000000000000000000000000000000000000000002',
    });

    currentTime = new Date(currentTime.getTime() + BASE_ABANDONMENT_TIMEOUT_MS + 1_000);
    await coordinator.pollPendingTransactions(10);

    const updated = store.getTransaction(transaction.id);
    expect(updated?.status).toBe('ABANDONED');
    expect(updated?.status).not.toBe('FAILED');
    expect(updated?.abandonedAt).not.toBeNull();
  }, 30_000);
});
