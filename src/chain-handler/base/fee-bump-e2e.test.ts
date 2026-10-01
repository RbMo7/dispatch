import { createPublicClient, http, parseTransaction, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Coordinator } from '../../coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { BASE_ABANDONMENT_TIMEOUT_MS, BaseChainHandler } from './base-chain-handler.js';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STUCK_AFTER_MS = 60_000;

/**
 * #9 (ADR-0037), against real Base Sepolia (ADR-0013). The first block
 * never broadcasts anything and costs nothing; the second deliberately
 * submits an underpriced transaction (maxFeePerGas below the current base
 * fee, so it can't be included), lets the Coordinator judge it stuck, and
 * proves the fee-bumped replacement at the same nonce is what lands.
 */
describe('BaseChainHandler fee-bump (real Base Sepolia)', () => {
  let testSigner: TestSignerHandle;
  let handler: BaseChainHandler;
  let releaseDevSenderLock: () => Promise<void>;
  const sender = getDevSenderAccount();
  const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
  /** The latest signed bytes this file put on the wire and hasn't yet seen land — cleaned up in afterAll so a failed run never leaves the dev-sender's nonce blocked for every other e2e file. */
  let unsettledSigned: string | undefined;

  beforeAll(async () => {
    releaseDevSenderLock = await acquireDevSenderLock();
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
    try {
      if (unsettledSigned) {
        const prepared = await handler.prepareReplacement(unsettledSigned, sender.address);
        if (prepared.ok) {
          const signed = await handler.sign(prepared.value, sender.address);
          const sent = signed.ok ? await handler.broadcast(signed.value) : undefined;
          if (sent?.ok) await client.waitForTransactionReceipt({ hash: sent.value.hash as Hex });
        }
      }
    } finally {
      await testSigner?.close();
      await releaseDevSenderLock?.();
    }
  }, 120_000);

  /** A signed zero-value self-transfer — optionally with fee fields/nonce overridden before signing. */
  async function signedSelfTransfer(
    override: Partial<{ maxFeePerGas: string; maxPriorityFeePerGas: string; nonce: number }> = {},
  ): Promise<string> {
    const prepared = await handler.prepare(
      [{ to: sender.address, data: '0x', value: '0' }],
      sender.address,
    );
    if (!prepared.ok || !prepared.value[0])
      throw new Error(`prepare failed: ${JSON.stringify(prepared)}`);
    const encoded = {
      ...decodeUnsignedTransaction(prepared.value[0].unsignedTransaction),
      ...override,
    };
    const signed = await handler.sign(
      { callIndex: 0, unsignedTransaction: encodeUnsignedTransaction(encoded) },
      sender.address,
    );
    if (!signed.ok) throw new Error(`sign failed: ${JSON.stringify(signed.error)}`);
    return signed.value;
  }

  describe('prepareReplacement (read-only, nothing broadcast)', () => {
    it('keeps the nonce, recipient and gas, and raises both fee fields by at least feeBumpPercent', async () => {
      const signedOriginal = await signedSelfTransfer();
      const original = parseTransaction(signedOriginal as Hex);

      const result = await handler.prepareReplacement(signedOriginal, sender.address);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const replacement = decodeUnsignedTransaction(result.value.unsignedTransaction);
      expect(replacement.nonce).toBe(original.nonce);
      expect(replacement.to.toLowerCase()).toBe(sender.address.toLowerCase());
      expect(replacement.gas).toBe(original.gas!.toString());
      expect(BigInt(replacement.maxFeePerGas)).toBeGreaterThanOrEqual(
        (original.maxFeePerGas! * 115n) / 100n,
      );
      expect(BigInt(replacement.maxPriorityFeePerGas)).toBeGreaterThanOrEqual(
        (original.maxPriorityFeePerGas! * 115n) / 100n,
      );
    }, 60_000);

    it('answers NONCE_ALREADY_USED for a nonce the Sender has already consumed on-chain', async () => {
      const signed = await signedSelfTransfer({ nonce: 0 });

      const result = await handler.prepareReplacement(signed, sender.address);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NONCE_ALREADY_USED');
    }, 60_000);
  });

  it('judges a deliberately underpriced transaction stuck, bumps it at the same nonce, and the replacement confirms', async () => {
    const block = await client.getBlock();
    const underpricedFeeCap = block.baseFeePerGas! / 2n;
    const tip = underpricedFeeCap < 1_000_000n ? underpricedFeeCap : 1_000_000n;
    // The handler's in-process nonce counter already moved past nonces the
    // read-only tests prepared but never sent — use the real next nonce.
    const nonce = await client.getTransactionCount({
      address: sender.address,
      blockTag: 'pending',
    });
    const underpriced = await signedSelfTransfer({
      nonce,
      maxFeePerGas: underpricedFeeCap.toString(),
      maxPriorityFeePerGas: tip.toString(),
    });

    const sent = await handler.broadcast(underpriced);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    unsettledSigned = underpriced;

    let currentTime = new Date();
    const store = new InMemoryDispatchStore(() => currentTime);
    const coordinator = new Coordinator({
      store,
      chainHandlers: new Map([['base', handler]]),
      senderAddresses: new Map([['base', sender.address]]),
      abandonmentTimeoutMs: new Map([['base', BASE_ABANDONMENT_TIMEOUT_MS]]),
      stuckHandling: new Map([['base', { stuckAfterMs: STUCK_AFTER_MS, maxFeeBumps: 5 }]]),
      now: () => currentTime,
    });
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: `fee-bump-e2e-${Date.now()}`,
      items: [{ call: { to: sender.address, data: '0x', value: '0' }, payment: null }],
      retryPolicy: true,
    });
    const original = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: underpriced,
      hash: sent.value.hash,
    });

    // A few real blocks later it's genuinely still pending — underpriced, not just slow.
    await sleep(6_000);
    await coordinator.pollPendingTransactions(10);
    expect(store.getTransaction(original.id)?.status).toBe('PENDING');

    currentTime = new Date(currentTime.getTime() + STUCK_AFTER_MS);
    await coordinator.pollPendingTransactions(10);

    const [, replacement] = store.listAllTransactions();
    expect(store.getTransaction(original.id)?.status).toBe('REPLACED');
    expect(replacement?.status).toBe('PENDING');
    expect(replacement?.replacesTransactionId).toBe(original.id);
    const bumped = parseTransaction(replacement!.signedBytes as Hex);
    expect(bumped.nonce).toBe(nonce);
    expect(bumped.maxFeePerGas! > block.baseFeePerGas!).toBe(true);
    unsettledSigned = replacement!.signedBytes!;

    const receipt = await client.waitForTransactionReceipt({ hash: replacement!.hash as Hex });
    expect(receipt.status).toBe('success');
    unsettledSigned = undefined;

    await coordinator.pollPendingTransactions(10);
    expect(store.getTransaction(replacement!.id)?.status).toBe('CONFIRMED');
    expect(store.getTransaction(original.id)?.status).toBe('DROPPED');
  }, 120_000);
});
