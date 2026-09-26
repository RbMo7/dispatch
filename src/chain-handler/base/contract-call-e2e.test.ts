import { createPublicClient, encodeFunctionData, http, type Abi, type Address, type PublicClient } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same public-RPC-gateway consistency caveat as the other e2e tests: poll rather than a single immediate read. */
async function waitForCount(
  client: PublicClient,
  address: Address,
  abi: Abi,
  expected: bigint,
  timeoutMs = 20_000,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = (await client.readContract({ address, abi, functionName: 'count' })) as bigint;
    if (count === expected) return count;
    if (Date.now() >= deadline) return count;
    await sleep(1_000);
  }
}

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
 * issue 05: a caller-supplied `EvmCall` that isn't derived from a Payment
 * — the same build/sign/broadcast pipeline issue 03 proved, with no
 * special-casing for "this is a contract call, not a transfer"
 * (ADR-0018/0027: `data` is opaque, this handler never interprets it).
 */
describe('BaseChainHandler smart contract call submission (real Base Sepolia)', () => {
  let testSigner: TestSignerHandle;
  let handler: BaseChainHandler;
  let token: TestTokenInfo;
  let client: PublicClient;
  let releaseDevSenderLock: () => Promise<void>;

  beforeAll(async () => {
    // See acquireDevSenderLock's doc comment: serializes every real-broadcast
    // e2e test file (including test-token deployment) against the one real
    // dev-sender account.
    releaseDevSenderLock = await acquireDevSenderLock();
    const sender = getDevSenderAccount();
    token = await getOrDeployTestToken();
    testSigner = await startTestSigner([sender]);
    client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
    handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      signerClient: new SignerClient(testSigner.url),
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });
  }, DEV_SENDER_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await testSigner?.close();
    await releaseDevSenderLock?.();
  });

  it('broadcasts a raw increment() call, confirms, and its emitted event/state change is independently checked', async () => {
    const sender = getDevSenderAccount();
    const countBefore = await client.readContract({
      address: token.address,
      abi: token.abi,
      functionName: 'count',
    });

    const call: EvmCall = {
      to: token.address,
      data: encodeFunctionData({ abi: token.abi, functionName: 'increment' }),
      value: '0',
    };

    const validation = await handler.validateCall(call);
    expect(validation.ok).toBe(true);

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

    const receipt = await client.waitForTransactionReceipt({
      hash: broadcastResult.value.hash as `0x${string}`,
    });
    expect(receipt.status).toBe('success');
    // The event, not just "the transaction confirmed": exactly one Incremented log from our contract.
    expect(receipt.logs.filter((log) => log.address.toLowerCase() === token.address.toLowerCase())).toHaveLength(1);

    const countAfter = await waitForCount(client, token.address, token.abi, (countBefore as bigint) + 1n);
    expect(countAfter).toBe((countBefore as bigint) + 1n);
  }, 120_000);

  it('a call to a contract that reverts is broadcast and fails on-chain, without crashing or silently misreporting', async () => {
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
    // A revert is still a successfully-broadcast, successfully-mined
    // transaction (it consumed gas and incremented the nonce) — its
    // *receipt* reports the revert, not `broadcast` itself.
    expect(broadcastResult.ok).toBe(true);
    if (!broadcastResult.ok) return;

    const receipt = await client.waitForTransactionReceipt({
      hash: broadcastResult.value.hash as `0x${string}`,
    });
    expect(receipt.status).toBe('reverted');
  }, 120_000);
});
