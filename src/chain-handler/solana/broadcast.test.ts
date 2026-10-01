import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/devnet-fixtures.js';

async function signOneTransfer(handler: SolanaChainHandler, sender: Keypair, recipient: Keypair) {
  const callResult = await handler.paymentToCall({
    recipient: recipient.publicKey.toBase58(),
    asset: 'SOL',
    // Solana requires a non-zero account balance to be rent-exempt (~0.00089
    // SOL for a bare system account) — a transfer below that to a brand-new
    // address is rejected outright, so tests use a comfortably larger amount.
    amount: '2000000',
  });
  if (!callResult.ok) throw new Error(JSON.stringify(callResult.error));
  const prepareResult = await handler.prepare([callResult.value], sender.publicKey.toBase58());
  if (!prepareResult.ok) throw new Error(JSON.stringify(prepareResult.error));
  const prepared = prepareResult.value[0];
  if (!prepared) throw new Error('prepare produced no PreparedTransaction');
  return handler.sign(prepared, sender.publicKey.toBase58());
}

describe('SolanaChainHandler.broadcast', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it('submits a correctly signed transaction and it actually lands on devnet', async () => {
    const sender = await getFundedSenderKeypair();
    const recipient = Keypair.generate();
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();

    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url, signer.token),
      senderAddress: sender.publicKey.toBase58(),
    });

    const signResult = await signOneTransfer(handler, sender, recipient);
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const broadcastResult = await handler.broadcast(signResult.value);

    expect(broadcastResult.ok).toBe(true);
    if (!broadcastResult.ok) return;
    expect(typeof broadcastResult.value.hash).toBe('string');
    expect(broadcastResult.value.hash.length).toBeGreaterThan(0);

    // broadcast() itself already polled to confirmation before returning ok
    // (pollUntilConfirmedOrExpired, HTTP-only) — no need to re-confirm here,
    // and connection.confirmTransaction would default to a WebSocket
    // subscription this test's RPC provider may not support anyway.
    const recipientBalance = await connection.getBalance(recipient.publicKey);
    expect(recipientBalance).toBe(2_000_000);
  }, 30_000);

  it('surfaces a broadcast rejection as a structured error, not a thrown exception', async () => {
    const handler = new SolanaChainHandler({
      connection: getDevnetConnection(),
      signerClient: new SignerClient('http://127.0.0.1:1', undefined),
      senderAddress: Keypair.generate().publicKey.toBase58(),
    });

    const result = await handler.broadcast('not-real-signed-bytes');

    expect(result.ok).toBe(false);
    expect(!result.ok && typeof result.error.code).toBe('string');
  });
});
