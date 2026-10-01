import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { ERC20_ABI } from './erc20.js';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTokenBalance(
  client: PublicClient,
  token: Address,
  owner: Address,
  expected: bigint,
  timeoutMs = 20_000,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const balance = await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner],
    });
    if (balance === expected) return balance;
    if (Date.now() >= deadline) return balance;
    await sleep(1_000);
  }
}

/** issue 04: ERC-20 payments reuse issue 03's build/sign/broadcast pipeline completely unchanged. */
describe('BaseChainHandler ERC-20 token transfer (real Base Sepolia)', () => {
  let testSigner: TestSignerHandle;
  let handler: BaseChainHandler;
  let token: TestTokenInfo;
  let releaseDevSenderLock: () => Promise<void>;

  beforeAll(async () => {
    // See acquireDevSenderLock's doc comment: serializes every real-broadcast
    // e2e test file (including test-token deployment) against the one real
    // dev-sender account.
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
      knownTokens: { TEST: { contractAddress: token.address, decimals: token.decimals } },
    });
  }, DEV_SENDER_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await testSigner?.close();
    await releaseDevSenderLock?.();
  });

  it('translates a known ERC-20 Payment and lands it on-chain, verified against the recipient token balance', async () => {
    const sender = getDevSenderAccount();
    const recipient = privateKeyToAddress(generatePrivateKey());
    const amount = 5_000n;
    const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });

    const callResult = await handler.paymentToCall({
      recipient,
      asset: 'TEST',
      amount: amount.toString(),
    });
    expect(callResult.ok).toBe(true);
    if (!callResult.ok) return;
    expect(callResult.value.to).toBe(token.address);
    expect(callResult.value.value).toBe('0');

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

    expect(await waitForTokenBalance(client, token.address, recipient, amount)).toBe(amount);
  }, 120_000);

  it('answers UNKNOWN_ASSET for an asset with no configured known token', async () => {
    const result = await handler.paymentToCall({
      recipient: getDevSenderAccount().address,
      asset: 'NOT_CONFIGURED',
      amount: '1',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('UNKNOWN_ASSET');
  });

  it('getBalance reads the known ERC-20 token balance via balanceOf, feeding the Funding Check', async () => {
    const sender = getDevSenderAccount();
    const result = await handler.getBalance(sender.address, 'TEST');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.asset).toBe('TEST');
    expect(BigInt(result.value.amount) > 0n).toBe(true);
  });
});
