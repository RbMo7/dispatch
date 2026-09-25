import { keccak256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { afterAll } from 'vitest';

import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { runChainHandlerConformanceSuite } from '../conformance.js';
import { BaseChainHandler } from './base-chain-handler.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  getDevSenderAccount,
  startTestSigner,
} from './test-support/base-fixtures.js';

/**
 * #14 (ADR-0015): BaseChainHandler against the exact shared suite
 * SolanaChainHandler runs, with no Base-specific carve-outs, against real
 * Base Sepolia (ADR-0013). Nothing here ever lands on-chain: the suite only
 * broadcasts bytes it expects to be rejected, and the "valid" signed
 * transaction is signed but never sent — so no dev-sender lock is needed,
 * and prepare's nonces stay in this process's own counter.
 */
const sender = getDevSenderAccount();
const signer = await startTestSigner([sender]);
afterAll(async () => {
  await signer.close();
});

const handler = await BaseChainHandler.create({
  rpcUrl: BASE_SEPOLIA_RPC_URL,
  chainId: BASE_SEPOLIA_CHAIN_ID,
  senderAddress: sender.address,
  signerClient: new SignerClient(signer.url),
  nonceHistoryStore: new InMemoryNonceHistoryStore(),
});

/** Signed outside the engine (Relay Dispatch's shape), never broadcast. */
const validSignedTransaction = await privateKeyToAccount(
  (sender.privateKeyHex.startsWith('0x')
    ? sender.privateKeyHex
    : `0x${sender.privateKeyHex}`) as Hex,
).signTransaction({
  type: 'eip1559',
  chainId: BASE_SEPOLIA_CHAIN_ID,
  nonce: 0, // long since used — this must never be sendable even by accident
  to: privateKeyToAddress(generatePrivateKey()),
  value: 1000n,
  gas: 21_000n,
  maxFeePerGas: 10_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
});

runChainHandlerConformanceSuite('base', () => handler, {
  senderAddress: sender.address,
  asset: 'ETH',
  validPayment: {
    recipient: privateKeyToAddress(generatePrivateKey()),
    asset: 'ETH',
    amount: '1000',
  },
  validCall: { to: privateKeyToAddress(generatePrivateKey()), data: '0x', value: '0' },
  invalidCall: { to: 'not-an-address', data: '0x', value: '0' },
  validSignedTransaction,
  invalidSignedTransaction: 'not-real-signed-bytes',
  // The hash of those never-sent bytes: well-formed, and never on-chain.
  neverBroadcastHash: keccak256(validSignedTransaction),
});
