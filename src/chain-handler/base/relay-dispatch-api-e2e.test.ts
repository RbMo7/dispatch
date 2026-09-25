import { createPublicClient, http, type Hex, type TransactionSerializable } from 'viem';
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { ChainRegistry } from '../../chain-registry/chain-registry.js';
import { Coordinator } from '../../coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { BASE_ABANDONMENT_TIMEOUT_MS, BaseChainHandler } from './base-chain-handler.js';
import {
  acquireDevSenderLock,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  getDevSenderAccount,
} from './test-support/base-fixtures.js';

const AUTH_TOKEN = 'test-token';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RelayGetResponseBody = {
  mode: string;
  status: string;
  transactionHash: string | null;
  error: { code?: string } | null;
};

/**
 * #13 (ADR-0032/0033), against real Base Sepolia (ADR-0013). Every
 * transaction here is signed entirely outside the engine — plain viem and
 * the dev-sender's key, no BaseChainHandler.sign or Signer anywhere — and
 * the handler itself is configured with an unrelated Sender, so nothing
 * about the relayed bytes can lean on this handler's own identity. The
 * validation cases never reach the network; one case lands a real
 * 1000-wei transfer.
 */
describe('Base Relay Dispatch (real Base Sepolia)', () => {
  const dev = getDevSenderAccount();
  const signer = privateKeyToAccount(
    (dev.privateKeyHex.startsWith('0x') ? dev.privateKeyHex : `0x${dev.privateKeyHex}`) as Hex,
  );
  const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
  const nonceHistoryStore = new InMemoryNonceHistoryStore();
  let handler: BaseChainHandler;
  let releaseDevSenderLock: () => Promise<void>;

  beforeAll(async () => {
    releaseDevSenderLock = await acquireDevSenderLock();
    handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: privateKeyToAddress(generatePrivateKey()), // not the relayed transactions' signer
      nonceHistoryStore,
    });
  }, 120_000);

  afterAll(async () => {
    await releaseDevSenderLock?.();
  });

  /** A transfer signed outside the engine, as raw bytes base64-encoded (docs/api.md's wire format). */
  async function externallySigned(
    override: Partial<TransactionSerializable> = {},
  ): Promise<string> {
    const block = await client.getBlock();
    const nonce = await client.getTransactionCount({
      address: signer.address,
      blockTag: 'pending',
    });
    const tx = {
      type: 'eip1559',
      chainId: BASE_SEPOLIA_CHAIN_ID,
      nonce,
      to: privateKeyToAddress(generatePrivateKey()),
      value: 1000n,
      gas: 21_000n,
      maxFeePerGas: block.baseFeePerGas! * 2n,
      maxPriorityFeePerGas: 1_000_000n,
      ...override,
    } as TransactionSerializable;
    const hex = await signer.signTransaction(tx);
    return Buffer.from(hex.slice(2), 'hex').toString('base64');
  }

  describe('validateSignedTransaction (no RPC, nothing broadcast)', () => {
    it('accepts an externally-signed EIP-1559 transaction for this chain, as base64 or 0x-hex', async () => {
      const base64 = await externallySigned();

      expect((await handler.validateSignedTransaction(base64)).ok).toBe(true);
      expect(
        (
          await handler.validateSignedTransaction(
            `0x${Buffer.from(base64, 'base64').toString('hex')}`,
          )
        ).ok,
      ).toBe(true);
    }, 60_000);

    it.each([
      [
        'a legacy transaction',
        {
          type: 'legacy',
          gasPrice: 10_000_000n,
          maxFeePerGas: undefined,
          maxPriorityFeePerGas: undefined,
        },
      ],
      [
        'a type 0x01 (EIP-2930) transaction',
        {
          type: 'eip2930',
          gasPrice: 10_000_000n,
          accessList: [],
          maxFeePerGas: undefined,
          maxPriorityFeePerGas: undefined,
        },
      ],
      ['a transaction signed for another chain ID', { chainId: 1 }],
    ] as const)(
      'rejects %s with a structured CHAIN_REJECTED',
      async (_label, override) => {
        const result = await handler.validateSignedTransaction(
          await externallySigned(override),
        );

        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.code).toBe('CHAIN_REJECTED');
      },
      60_000,
    );

    it('rejects a malformed signature (s = 0)', async () => {
      const hex = `0x${Buffer.from(await externallySigned(), 'base64').toString('hex')}`;
      // The last 33 bytes of a type-2 RLP body are 0xa0 + s (32 bytes): zero s out.
      const tampered = `${hex.slice(0, -64)}${'0'.repeat(64)}`;

      const result = await handler.validateSignedTransaction(tampered);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('CHAIN_REJECTED');
    }, 60_000);
  });

  it('rejects a malformed or wrong-chain submission with 400 via the API and never persists it', async () => {
    const store = new InMemoryDispatchStore();
    const chainRegistry = await ChainRegistry.load(['base'], {
      base: () => Promise.resolve(handler),
    });
    const app = buildApp({
      store,
      chainRegistry,
      authToken: AUTH_TOKEN,
      defaultRetryPolicy: false,
    });

    for (const signedTransaction of [
      'not-real-signed-bytes',
      await externallySigned({ chainId: 1 }),
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          'idempotency-key': `base-relay-bad-${Math.random()}`,
        },
        payload: { chain: 'base', mode: 'relay', signedTransaction },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await store.claimQueuedRelayDispatches(10)).toEqual([]);
  }, 60_000);

  it('relays an externally-signed transfer through POST /v1/dispatch to confirmed, verified on-chain', async () => {
    const recipient = privateKeyToAddress(generatePrivateKey());
    const signedTransaction = await externallySigned({ to: recipient });

    const store = new InMemoryDispatchStore();
    const chainRegistry = await ChainRegistry.load(['base'], {
      base: () => Promise.resolve(handler),
    });
    const app = buildApp({
      store,
      chainRegistry,
      authToken: AUTH_TOKEN,
      defaultRetryPolicy: false,
    });
    const post = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        'idempotency-key': `base-relay-${Date.now()}`,
      },
      payload: { chain: 'base', mode: 'relay', signedTransaction },
    });
    expect(post.statusCode).toBe(202);
    const { dispatchId } = post.json<{ dispatchId: string }>();

    const coordinator = new Coordinator({
      store,
      chainHandlers: chainRegistry.handlers,
      senderAddresses: new Map([['base', signer.address]]),
      abandonmentTimeoutMs: new Map([['base', BASE_ABANDONMENT_TIMEOUT_MS]]),
    });
    await coordinator.processQueuedRelayDispatches(10);

    let body: RelayGetResponseBody | undefined;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await coordinator.pollPendingTransactions(10);
      const get = await app.inject({
        method: 'GET',
        url: `/v1/dispatch/${dispatchId}`,
        headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      });
      body = get.json<RelayGetResponseBody>();
      if (body.status !== 'queued' && body.status !== 'broadcasting') break;
      await sleep(1_500);
    }

    expect(body).toMatchObject({ mode: 'relay', status: 'confirmed', error: null });
    // Independent, real-chain proof — the public gateway can lag a node behind the receipt.
    let balance = 0n;
    for (let i = 0; i < 10 && balance === 0n; i++, await sleep(1_000)) {
      balance = await client.getBalance({ address: recipient });
    }
    expect(balance).toBe(1000n);
    // Bookkeeping derived from the bytes: recorded under the signer that
    // actually signed them, not this handler's own configured Sender.
    const history = await nonceHistoryStore.listNonceHistory('base', signer.address);
    expect(history.some((h) => h.hash.toLowerCase() === body!.transactionHash!.toLowerCase())).toBe(
      true,
    );
  }, 120_000);
});
