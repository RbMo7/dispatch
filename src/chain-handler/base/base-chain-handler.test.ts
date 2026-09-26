import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { BaseChainHandler } from './base-chain-handler.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  acquireDevSenderLock,
  DEV_SENDER_LOCK_HOOK_TIMEOUT_MS,
  getDevSenderAccount,
} from './test-support/base-fixtures.js';

/**
 * ADR-0013: exercised against real Base Sepolia RPC throughout, no fake
 * chain-ID/nonce behavior standing in anywhere a real one is being tested
 * — mirroring solana-chain-handler's own real-devnet discipline.
 */
describe('BaseChainHandler.create (real Base Sepolia)', () => {
  it('succeeds when the configured chainId matches the connected RPC', async () => {
    const sender = getDevSenderAccount();

    const handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });

    expect(handler.chain).toBe('base');
  });

  it('refuses to construct when the configured chainId does not match the connected RPC', async () => {
    const sender = getDevSenderAccount();

    await expect(
      BaseChainHandler.create({
        rpcUrl: BASE_SEPOLIA_RPC_URL,
        chainId: 1, // Ethereum mainnet — deliberately wrong for a Base Sepolia RPC
        senderAddress: sender.address,
        nonceHistoryStore: new InMemoryNonceHistoryStore(),
      }),
    ).rejects.toThrow(/eth_chainId/);
  });

  it('rejects a malformed senderAddress before ever making an RPC call', async () => {
    await expect(
      BaseChainHandler.create({
        rpcUrl: BASE_SEPOLIA_RPC_URL,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        senderAddress: 'not-an-address',
        nonceHistoryStore: new InMemoryNonceHistoryStore(),
      }),
    ).rejects.toThrow(/well-formed EVM address/);
  });
});

describe('BaseChainHandler nonce authority (real Base Sepolia)', () => {
  // These tests assume the real chain's nonce stays put across two RPC
  // reads within one test — an assumption only the dev-sender lock can
  // actually guarantee, since other e2e files genuinely broadcast against
  // this same account in parallel (see acquireDevSenderLock's own doc
  // comment).
  let releaseDevSenderLock: () => Promise<void>;
  beforeAll(async () => {
    releaseDevSenderLock = await acquireDevSenderLock();
  }, DEV_SENDER_LOCK_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await releaseDevSenderLock();
  });

  it('initializes the next-nonce counter from eth_getTransactionCount on construction', async () => {
    const sender = getDevSenderAccount();

    const handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });

    // Whatever the real chain currently reports — this only proves it was
    // actually read from eth_getTransactionCount, not hardcoded to 0.
    const expected = await fetchRealTransactionCount(sender.address);
    expect(handler.peekNextNonce()).toBe(expected);
  });

  it('assigns sequential, non-colliding nonces with no RPC call per assignment', async () => {
    const sender = getDevSenderAccount();
    const handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });

    const first = handler.testOnlyAssignNextNonce();
    const second = handler.testOnlyAssignNextNonce();

    expect(second).toBe(first + 1);
  });

  it('resyncNonce corrects an artificially drifted counter back to the real on-chain value', async () => {
    const sender = getDevSenderAccount();
    const handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });
    const real = await fetchRealTransactionCount(sender.address);

    // Simulate drift: assign several nonces with nothing ever actually broadcast.
    handler.testOnlyAssignNextNonce();
    handler.testOnlyAssignNextNonce();
    handler.testOnlyAssignNextNonce();
    expect(handler.peekNextNonce()).toBe(real + 3);

    await handler.testOnlyResyncNonce();

    expect(handler.peekNextNonce()).toBe(real);
  });
});

async function fetchRealTransactionCount(address: string): Promise<number> {
  const response = await fetch(BASE_SEPOLIA_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionCount',
      params: [address, 'latest'],
    }),
  });
  const body = (await response.json()) as { result: string };
  return Number.parseInt(body.result, 16);
}
