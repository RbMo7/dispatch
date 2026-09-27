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

  it('lands a transfer carrying its priority fee and a compute-unit limit near its real usage (#34, #37)', async () => {
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
    if (!landed) throw new Error('landed transaction not found');
    const { message } = landed.transaction;
    const budget = message.compiledInstructions
      .filter((i) =>
        message.staticAccountKeys[i.programIdIndex]?.equals(ComputeBudgetProgram.programId),
      )
      .map((i) => Buffer.from(i.data));
    expect(budget.map((data) => data[0])).toEqual([2, 3]); // SetComputeUnitLimit, SetComputeUnitPrice

    // #37: the limit is the simulated usage plus margin, not the 200k-per-instruction default.
    const limit = budget[0]!.readUInt32LE(1);
    const used = landed.meta?.computeUnitsConsumed ?? 0;
    expect(limit).toBeGreaterThanOrEqual(used);
    expect(limit).toBeLessThan(used * 1.5);
    expect(limit).toBeLessThan(10_000); // a plain transfer uses a few hundred units
  }, 120_000);

  it('lands a transfer priced automatically from recent fees, within its ceiling (#43)', async () => {
    const sender = await getFundedSenderKeypair();
    const senderAddress = sender.publicKey.toBase58();
    const recipient = Keypair.generate();
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();
    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url),
      senderAddress,
      computeUnitPriceMicroLamports: 'auto',
      maxComputeUnitPriceMicroLamports: 50_000,
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
    if (!landed) throw new Error('landed transaction not found');
    const { message } = landed.transaction;
    const price = message.compiledInstructions
      .filter((i) =>
        message.staticAccountKeys[i.programIdIndex]?.equals(ComputeBudgetProgram.programId),
      )
      .map((i) => Buffer.from(i.data))
      .find((data) => data[0] === 3);
    expect(price).toBeDefined();
    const microLamports = price!.readBigUInt64LE(1);
    console.log(`#43: auto priority fee on devnet = ${microLamports} micro-lamports/CU`);
    expect(microLamports).toBeLessThanOrEqual(50_000n);
  }, 120_000);
});
