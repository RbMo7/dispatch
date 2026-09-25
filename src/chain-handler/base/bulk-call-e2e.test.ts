import { createPublicClient, encodeFunctionData, erc20Abi, http } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { ChainRegistry } from '../../chain-registry/chain-registry.js';
import { Coordinator } from '../../coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { BASE_ABANDONMENT_TIMEOUT_MS, BaseChainHandler } from './base-chain-handler.js';
import { CANONICAL_MULTICALL3 } from './bulk-call.js';
import {
  acquireDevSenderLock,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  DEV_SENDER_LOCK_HOOK_TIMEOUT_MS,
  getDevSenderAccount,
  getOrDeployTestAggregator,
  getOrDeployTestToken,
  startTestSigner,
  type TestSignerHandle,
  type TestTokenInfo,
} from './test-support/base-fixtures.js';

const AUTH_TOKEN = 'test-token';
/** A tracing-capable Base Sepolia RPC — the public one and Alchemy's free tier both refuse debug_traceTransaction. */
const TRACE_RPC_URL = process.env.BASE_TRACE_RPC_URL ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GetBody = {
  status: string;
  items: { status: string; error: { chainDetail?: unknown } | null }[];
};

/**
 * #11 (ADR-0038), against real Base Sepolia (ADR-0013). The canonical
 * Multicall3 guard needs no network beyond construction. The mixed-outcome
 * bundle needs a tracing RPC (BASE_TRACE_RPC_URL) — without one it is
 * skipped, saying so, rather than faked.
 */
describe('Base Bulk Call (real Base Sepolia)', () => {
  const sender = getDevSenderAccount();

  function appWith(handler: BaseChainHandler) {
    const store = new InMemoryDispatchStore();
    return ChainRegistry.load(['base'], { base: () => Promise.resolve(handler) }).then(
      (chainRegistry) => ({
        store,
        chainRegistry,
        app: buildApp({ store, chainRegistry, authToken: AUTH_TOKEN, defaultRetryPolicy: false }),
      }),
    );
  }

  it('refuses an ERC-20 item through the canonical, permissionless Multicall3 with 400', async () => {
    const handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
      knownTokens: {
        TEST: { contractAddress: '0x000000000000000000000000000000000000dEaD', decimals: 6 },
      },
      // Only enables Bulk Call for this check; nothing here is ever traced.
      traceRpcUrl: BASE_SEPOLIA_RPC_URL,
    });
    const { app } = await appWith(handler);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        'idempotency-key': `bulk-canonical-${Date.now()}`,
      },
      payload: {
        chain: 'base',
        bulkCall: { aggregator: CANONICAL_MULTICALL3 },
        items: [{ type: 'payment', recipient: sender.address, asset: 'TEST', amount: '1' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message?: string }>().message).toMatch(/canonical Multicall3/);
  }, 60_000);

  it('refuses an aggregator with no contract code (an EOA would just take the native total) with 400', async () => {
    const handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
      traceRpcUrl: BASE_SEPOLIA_RPC_URL, // only enables Bulk Call for this check
    });
    const { app } = await appWith(handler);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        'idempotency-key': `bulk-eoa-${Date.now()}`,
      },
      payload: {
        chain: 'base',
        bulkCall: { aggregator: privateKeyToAddress(generatePrivateKey()) },
        items: [{ type: 'payment', recipient: sender.address, asset: 'ETH', amount: '1' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code?: string }>().code).toBe('INVALID_RECIPIENT');
  }, 60_000);

  describe('through a caller-owned aggregator', () => {
    let testSigner: TestSignerHandle;
    let releaseDevSenderLock: () => Promise<void>;
    let token: TestTokenInfo;
    let aggregator: `0x${string}`;
    let handler: BaseChainHandler;

    beforeAll(async () => {
      releaseDevSenderLock = await acquireDevSenderLock();
      testSigner = await startTestSigner([sender]);
      token = await getOrDeployTestToken();
      aggregator = await getOrDeployTestAggregator();
      handler = await BaseChainHandler.create({
        rpcUrl: BASE_SEPOLIA_RPC_URL,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        senderAddress: sender.address,
        signerClient: new SignerClient(testSigner.url),
        nonceHistoryStore: new InMemoryNonceHistoryStore(),
        knownTokens: { TEST: { contractAddress: token.address, decimals: token.decimals } },
        ...(TRACE_RPC_URL ? { traceRpcUrl: TRACE_RPC_URL } : {}),
      });
    }, DEV_SENDER_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await testSigner?.close();
      await releaseDevSenderLock?.();
    });

    it("lands one aggregate3Value transaction whose native, ERC-20 and raw-call items each take effect, while a reverting item doesn't revert the bundle", async () => {
      const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
      const nativeRecipient = privateKeyToAddress(generatePrivateKey());
      const tokenRecipient = privateKeyToAddress(generatePrivateKey());
      const countBefore = (await client.readContract({
        address: token.address,
        abi: token.abi,
        functionName: 'count',
      })) as bigint;
      const calls = [
        { to: nativeRecipient, data: '0x', value: '1000' },
        {
          to: token.address,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [tokenRecipient, 7n],
          }),
          value: '0',
        },
        {
          to: token.address,
          data: encodeFunctionData({ abi: token.abi, functionName: 'increment' }),
          value: '0',
        },
        {
          to: token.address,
          data: encodeFunctionData({ abi: token.abi, functionName: 'revertAlways' }),
          value: '0',
        },
      ];

      const prepared = await handler.prepare(calls, sender.address, {
        bulkCall: { aggregator, maxBatchSize: 50 },
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(new Set(prepared.value.map((p) => p.unsignedTransaction)).size).toBe(1); // one chunk
      const signed = await handler.sign(prepared.value[0]!, sender.address);
      if (!signed.ok) throw new Error(`sign failed: ${JSON.stringify(signed.error)}`);
      const sent = await handler.broadcast(signed.value);
      if (!sent.ok) throw new Error(`broadcast failed: ${JSON.stringify(sent.error)}`);

      const receipt = await client.waitForTransactionReceipt({
        hash: sent.value.hash as `0x${string}`,
      });
      expect(receipt.status).toBe('success'); // the reverting item did not take the bundle down

      let nativeBalance = 0n;
      for (let i = 0; i < 10 && nativeBalance === 0n; i++, await sleep(1_000)) {
        nativeBalance = await client.getBalance({ address: nativeRecipient });
      }
      expect(nativeBalance).toBe(1000n);
      expect(
        await client.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [tokenRecipient],
        }),
      ).toBe(7n); // from the aggregator's own balance
      expect(
        await client.readContract({
          address: token.address,
          abi: token.abi,
          functionName: 'count',
        }),
      ).toBe(countBefore + 1n);
    }, 180_000);

    it.skipIf(!TRACE_RPC_URL)(
      "reports each item's own outcome through the API — native, ERC-20 and raw call confirmed, the reverting call failed alone (needs BASE_TRACE_RPC_URL)",
      async () => {
        const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
        const nativeRecipient = privateKeyToAddress(generatePrivateKey());
        const tokenRecipient = privateKeyToAddress(generatePrivateKey());
        const { app, store, chainRegistry } = await appWith(handler);

        const post = await app.inject({
          method: 'POST',
          url: '/v1/dispatch',
          headers: {
            authorization: `Bearer ${AUTH_TOKEN}`,
            'idempotency-key': `bulk-mixed-${Date.now()}`,
          },
          payload: {
            chain: 'base',
            bulkCall: { aggregator },
            items: [
              { type: 'payment', recipient: nativeRecipient, asset: 'ETH', amount: '1000' },
              { type: 'payment', recipient: tokenRecipient, asset: 'TEST', amount: '7' },
              {
                type: 'call',
                to: token.address,
                data: encodeFunctionData({ abi: token.abi, functionName: 'increment' }),
                value: '0',
              },
              {
                type: 'call',
                to: token.address,
                data: encodeFunctionData({ abi: token.abi, functionName: 'revertAlways' }),
                value: '0',
              },
            ],
          },
        });
        expect(post.statusCode).toBe(202);
        const { dispatchId } = post.json<{ dispatchId: string }>();

        const coordinator = new Coordinator({
          store,
          chainHandlers: chainRegistry.handlers,
          senderAddresses: new Map([['base', sender.address]]),
          abandonmentTimeoutMs: new Map([['base', BASE_ABANDONMENT_TIMEOUT_MS]]),
        });
        await coordinator.processQueuedDispatches(10);

        // One chunk: every item rides the same transaction.
        const hashes = new Set((await store.listTransactions(dispatchId)).map((t) => t.hash));
        expect(hashes.size).toBe(1);

        let body: GetBody | undefined;
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          await coordinator.pollPendingTransactions(10);
          const get = await app.inject({
            method: 'GET',
            url: `/v1/dispatch/${dispatchId}`,
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          });
          body = get.json<GetBody>();
          if (body.items.every((i) => i.status !== 'broadcasting' && i.status !== 'queued')) break;
          await sleep(2_000);
        }

        expect(body?.items.map((i) => i.status)).toEqual([
          'confirmed',
          'confirmed',
          'confirmed',
          'failed',
        ]);
        expect(body?.status).toBe('partial');
        expect(body?.items[3]?.error?.chainDetail).toMatchObject({ slot: 3 });

        // Independent, real-chain proof of each item's own effect.
        let nativeBalance = 0n;
        for (let i = 0; i < 10 && nativeBalance === 0n; i++, await sleep(1_000)) {
          nativeBalance = await client.getBalance({ address: nativeRecipient });
        }
        expect(nativeBalance).toBe(1000n);
        expect(
          await client.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [tokenRecipient],
          }),
        ).toBe(7n);
      },
      180_000,
    );
  });
});
