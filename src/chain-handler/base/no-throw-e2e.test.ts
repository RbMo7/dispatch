import { createPublicClient, http, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NonceHistoryStore } from '../../repository/nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { BaseChainHandler } from './base-chain-handler.js';
import {
  acquireDevSenderLock,
  DEV_SENDER_LOCK_HOOK_TIMEOUT_MS,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  getDevSenderAccount,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/base-fixtures.js';
import { decodeUnsignedTransaction, encodeUnsignedTransaction } from './transaction-codec.js';

/**
 * #10: "No error produced anywhere in #3/#6/#9's paths surfaces as a thrown
 * exception instead of a structured Result error", against real Base
 * Sepolia (ADR-0013). The sign cases never reach the network; the broadcast
 * case sends one real zero-value self-transfer.
 */
describe('BaseChainHandler never throws on its sign/broadcast paths (#10, real Base Sepolia)', () => {
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

  function createHandler(nonceHistoryStore: NonceHistoryStore) {
    return BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      signerClient: new SignerClient(testSigner.url, testSigner.token),
      nonceHistoryStore,
    });
  }

  const inertHistory: NonceHistoryStore = {
    recordNonce: () => Promise.resolve(),
    listNonceHistory: () => Promise.resolve([]),
  };

  it('sign answers an undecodable PreparedTransaction with a structured error', async () => {
    const handler = await createHandler(inertHistory);

    const result = await handler.sign(
      { callIndex: 0, unsignedTransaction: 'not-a-prepared-transaction' },
      sender.address,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('CHAIN_REJECTED');
  }, 60_000);

  it('sign answers fee fields viem refuses to serialize (tip above the fee cap) with a structured error', async () => {
    const handler = await createHandler(inertHistory);
    const prepared = await handler.prepare(
      [{ to: sender.address, data: '0x', value: '0' }],
      sender.address,
    );
    if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
    const encoded = {
      ...decodeUnsignedTransaction(prepared.value[0].unsignedTransaction),
      maxFeePerGas: '1',
      maxPriorityFeePerGas: '2',
    };

    const result = await handler.sign(
      { callIndex: 0, unsignedTransaction: encodeUnsignedTransaction(encoded) },
      sender.address,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('CHAIN_REJECTED');
    expect(!result.ok && result.error.message).toMatch(/tip|fee cap/i);
  }, 60_000);

  it('broadcast still returns the hash of a transaction that landed even if recording its nonce history fails', async () => {
    const failingHistory: NonceHistoryStore = {
      recordNonce: () => Promise.reject(new Error('nonce_history insert failed')),
      listNonceHistory: () => Promise.resolve([]),
    };
    const handler = await createHandler(failingHistory);
    const prepared = await handler.prepare(
      [{ to: sender.address, data: '0x', value: '0' }],
      sender.address,
    );
    if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
    const signed = await handler.sign(prepared.value[0], sender.address);
    if (!signed.ok) throw new Error(`sign failed: ${JSON.stringify(signed.error)}`);

    const result = await handler.broadcast(signed.value);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = await createPublicClient({
      transport: http(BASE_SEPOLIA_RPC_URL),
    }).waitForTransactionReceipt({
      hash: result.value.hash as Hex,
    });
    expect(receipt.status).toBe('success');
  }, 120_000);
});
