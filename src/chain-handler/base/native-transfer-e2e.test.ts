import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Base Sepolia's public RPC endpoint is a multi-node gateway with no
 * read-after-write guarantee across nodes — a `getBalance` immediately
 * after a confirmed receipt can still land on a lagging node and read
 * stale state (observed directly: a receipt reported `success` while the
 * very next `getBalance` call read the pre-transfer balance, which then
 * reflected the transfer correctly moments later). Polling here is working
 * around that gateway property, not this handler's own correctness.
 */
async function waitForBalance(
  client: PublicClient,
  address: Address,
  expected: bigint,
  timeoutMs = 20_000,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const balance = await client.getBalance({ address });
    if (balance === expected) return balance;
    if (Date.now() >= deadline) return balance;
    await sleep(1_000);
  }
}

import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { BaseChainHandler } from './base-chain-handler.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  acquireDevSenderLock,
  getDevSenderAccount,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/base-fixtures.js';

/**
 * issue 03: the first full vertical slice, proven against real Base
 * Sepolia (ADR-0013) — paymentToCall -> validateCall -> prepare -> sign ->
 * broadcast, independently verified against the recipient's real balance
 * change, not just "broadcast returned ok".
 */
describe('BaseChainHandler native ETH transfer (real Base Sepolia)', () => {
  let testSigner: TestSignerHandle;
  let nonceHistoryStore: InMemoryNonceHistoryStore;
  let handler: BaseChainHandler;
  let releaseDevSenderLock: () => Promise<void>;

  beforeAll(async () => {
    // See acquireDevSenderLock's doc comment: serializes every real-broadcast
    // e2e test file against the one real dev-sender account.
    releaseDevSenderLock = await acquireDevSenderLock();
    const sender = getDevSenderAccount();
    testSigner = await startTestSigner([sender]);
    nonceHistoryStore = new InMemoryNonceHistoryStore();
    handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      signerClient: new SignerClient(testSigner.url),
      nonceHistoryStore,
    });
  }, 120_000);

  afterAll(async () => {
    await testSigner?.close();
    await releaseDevSenderLock?.();
  });

  it('lands a native ETH payment on-chain, verified against the recipient balance and the nonce history', async () => {
    const sender = getDevSenderAccount();
    const recipient = privateKeyToAddress(generatePrivateKey()); // a fresh, never-before-seen address
    const amount = 1000n;
    const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });

    expect(await client.getBalance({ address: recipient })).toBe(0n);

    const callResult = await handler.paymentToCall({
      recipient,
      asset: 'ETH',
      amount: amount.toString(),
    });
    expect(callResult.ok).toBe(true);
    if (!callResult.ok) return;
    expect(callResult.value).toEqual({ to: recipient, data: '0x', value: amount.toString() });

    const validation = await handler.validateCall(callResult.value);
    expect(validation.ok).toBe(true);

    const prepareResult = await handler.prepare([callResult.value], sender.address);
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

    const receipt = await client.waitForTransactionReceipt({
      hash: broadcastResult.value.hash as `0x${string}`,
    });
    expect(receipt.status).toBe('success');

    expect(await waitForBalance(client, recipient, amount)).toBe(amount);

    const history = await nonceHistoryStore.listNonceHistory('base', sender.address);
    expect(history.some((h) => h.hash.toLowerCase() === broadcastResult.value.hash.toLowerCase())).toBe(
      true,
    );
  }, 60_000);
});
