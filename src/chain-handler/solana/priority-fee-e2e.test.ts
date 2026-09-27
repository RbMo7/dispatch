import { ComputeBudgetProgram, Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/devnet-fixtures.js';

/** #34, real devnet (ADR-0013): a transaction built with a priority fee lands, and carries it on-chain. */
describe('SolanaChainHandler priority fee on devnet (#34)', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it('lands a transfer that carries a SetComputeUnitPrice instruction', async () => {
    const sender = await getFundedSenderKeypair();
    const senderAddress = sender.publicKey.toBase58();
    const recipient = Keypair.generate();
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();
    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url),
      senderAddress,
      computeUnitPriceMicroLamports: 1_000,
    });

    const call = await handler.paymentToCall({
      recipient: recipient.publicKey.toBase58(),
      asset: 'SOL',
      amount: '2000000',
    });
    if (!call.ok) throw new Error('paymentToCall failed');
    const prepared = await handler.prepare([call.value], senderAddress);
    if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
    const signed = await handler.sign(prepared.value[0], senderAddress);
    if (!signed.ok) throw new Error('sign failed');
    const broadcast = await handler.broadcast(signed.value);
    expect(broadcast.ok).toBe(true);
    if (!broadcast.ok) return;

    expect(await connection.getBalance(recipient.publicKey)).toBe(2_000_000);
    const landed = await connection.getTransaction(broadcast.value.hash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const keys = landed?.transaction.message.staticAccountKeys ?? [];
    expect(keys.some((k) => k.equals(ComputeBudgetProgram.programId))).toBe(true);
  }, 120_000);
});
