import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  startTestSigner,
} from './test-support/devnet-fixtures.js';

describe('SolanaChainHandler.getStatus', () => {
  it('reports PENDING for a hash that was never broadcast', async () => {
    const handler = new SolanaChainHandler({
      connection: getDevnetConnection(),
      signerClient: new SignerClient('http://127.0.0.1:1', undefined),
      senderAddress: Keypair.generate().publicKey.toBase58(),
    });

    // A syntactically valid (but never-used) 64-byte signature — a malformed
    // one would make getSignatureStatuses itself reject the request, which
    // isn't what this test is about.
    const neverBroadcastHash = bs58.encode(Buffer.alloc(64, 7));
    const result = await handler.getStatus(neverBroadcastHash);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe('PENDING');
  });

  it('reports CONFIRMED for a transaction that actually landed on devnet', async () => {
    const sender = await getFundedSenderKeypair();
    const recipient = Keypair.generate();
    const signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();

    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url, signer.token),
      senderAddress: sender.publicKey.toBase58(),
    });

    const callResult = await handler.paymentToCall({
      recipient: recipient.publicKey.toBase58(),
      asset: 'SOL',
      amount: '2000000',
    });
    expect(callResult.ok).toBe(true);
    if (!callResult.ok) return;
    const prepareResult = await handler.prepare([callResult.value], sender.publicKey.toBase58());
    if (!prepareResult.ok) throw new Error('prepare failed');
    const prepared = prepareResult.value[0];
    if (!prepared) throw new Error('no prepared transaction');
    const signResult = await handler.sign(prepared, sender.publicKey.toBase58());
    if (!signResult.ok) throw new Error('sign failed');
    const broadcastResult = await handler.broadcast(signResult.value);
    expect(broadcastResult.ok).toBe(true);
    if (!broadcastResult.ok) return;

    await signer.close();

    const status = await handler.getStatus(broadcastResult.value.hash);

    expect(status.ok).toBe(true);
    expect(status.ok && status.value).toBe('CONFIRMED');
  }, 30_000);

  it('reports FAILED for a transaction the network genuinely rejected during execution', async () => {
    // broadcast()'s own skipPreflight:false simulation catches most failures
    // before a signature even exists (as issue 05's rent-exemption bug
    // showed), so a real, distinct "reached the network but failed on-chain"
    // case needs skipPreflight:true — submitted directly, bypassing this
    // handler entirely, purely to produce a real genuinely-failed signature
    // for getStatus to read back.
    const funder = await getFundedSenderKeypair();
    const poorSender = Keypair.generate();
    const recipient = Keypair.generate();
    const connection = getDevnetConnection();

    // Fund poorSender with just enough to be rent-exempt plus a tx fee,
    // nowhere near enough to cover the transfer it's about to attempt.
    const fundingTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: poorSender.publicKey,
        lamports: 1_000_000,
      }),
    );
    await connection.sendTransaction(fundingTx, [funder], { skipPreflight: false });
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const doomedTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: poorSender.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 5_000_000_000,
      }),
    );
    let hash: string;
    try {
      hash = await connection.sendTransaction(doomedTx, [poorSender], { skipPreflight: true });
    } catch {
      // Devnet occasionally still catches this even with skipPreflight; if
      // it never reaches the network at all there's no signature to check
      // getStatus against, so this assertion isn't reachable — skip it.
      return;
    }

    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient('http://127.0.0.1:1', undefined),
      senderAddress: funder.publicKey.toBase58(),
    });

    let status: Awaited<ReturnType<typeof handler.getStatus>> | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      status = await handler.getStatus(hash);
      if (status.ok && status.value !== 'PENDING') break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    expect(status?.ok).toBe(true);
    expect(status?.ok && status.value).toBe('FAILED');
  }, 30_000);
});
