import { encodeFunctionData } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EvmCall } from '../../domain/call.js';
import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { BaseChainHandler } from './base-chain-handler.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  acquireDevSenderLock,
  DEV_SENDER_LOCK_HOOK_TIMEOUT_MS,
  getDevSenderAccount,
  getOrDeployTestToken,
  startTestSigner,
  type TestSignerHandle,
  type TestTokenInfo,
} from './test-support/base-fixtures.js';

/**
 * issue 06: getStatus wired into the Coordinator's existing polling loop
 * with zero Base-specific branching inside it (Coordinator.
 * pollPendingTransactions calls handler.getStatus generically, already
 * proven by core-engine-scaffold/solana-chain-handler's own tests) — this
 * file proves getStatus's own three outcomes against real Base Sepolia.
 */
describe('BaseChainHandler.getStatus (real Base Sepolia)', () => {
  let testSigner: TestSignerHandle;
  let handler: BaseChainHandler;
  let token: TestTokenInfo;
  let releaseDevSenderLock: () => Promise<void>;

  beforeAll(async () => {
    releaseDevSenderLock = await acquireDevSenderLock();
    const sender = getDevSenderAccount();
    token = await getOrDeployTestToken();
    testSigner = await startTestSigner([sender]);
    handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      signerClient: new SignerClient(testSigner.url, testSigner.token),
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });
  }, DEV_SENDER_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await testSigner?.close();
    await releaseDevSenderLock?.();
  });

  it('reports PENDING for a hash that was never broadcast', async () => {
    const result = await handler.getStatus(
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    );
    expect(result).toEqual({ ok: true, value: 'PENDING' });
  });

  it('reports CONFIRMED within roughly Base\'s ~2s inclusion window for a transaction that actually landed', async () => {
    const sender = getDevSenderAccount();
    const call: EvmCall = {
      to: token.address,
      data: encodeFunctionData({ abi: token.abi, functionName: 'increment' }),
      value: '0',
    };

    const prepareResult = await handler.prepare([call], sender.address);
    expect(prepareResult.ok).toBe(true);
    if (!prepareResult.ok) return;
    const prepared = prepareResult.value[0];
    if (!prepared) throw new Error('prepare returned no PreparedTransaction');

    const signResult = await handler.sign(prepared, sender.address);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const broadcastResult = await handler.broadcast(signResult.value);
    expect(broadcastResult.ok).toBe(true);
    if (!broadcastResult.ok) return;

    const startedAt = Date.now();
    let status = await handler.getStatus(broadcastResult.value.hash);
    while (status.ok && status.value === 'PENDING' && Date.now() - startedAt < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = await handler.getStatus(broadcastResult.value.hash);
    }

    expect(status).toEqual({ ok: true, value: 'CONFIRMED' });
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  }, 60_000);

  it('reports FAILED, distinct from PENDING, for a call that reverted on-chain', async () => {
    const sender = getDevSenderAccount();
    const call: EvmCall = {
      to: token.address,
      data: encodeFunctionData({ abi: token.abi, functionName: 'revertAlways' }),
      value: '0',
    };

    const prepareResult = await handler.prepare([call], sender.address);
    expect(prepareResult.ok).toBe(true);
    if (!prepareResult.ok) return;
    const prepared = prepareResult.value[0];
    if (!prepared) throw new Error('prepare returned no PreparedTransaction');

    const signResult = await handler.sign(prepared, sender.address);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const broadcastResult = await handler.broadcast(signResult.value);
    expect(broadcastResult.ok).toBe(true);
    if (!broadcastResult.ok) return;

    const startedAt = Date.now();
    let status = await handler.getStatus(broadcastResult.value.hash);
    while (status.ok && status.value === 'PENDING' && Date.now() - startedAt < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = await handler.getStatus(broadcastResult.value.hash);
    }

    expect(status).toEqual({ ok: true, value: 'FAILED' });
  }, 60_000);
});
