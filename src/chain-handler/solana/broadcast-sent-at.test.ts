import {
  type Connection,
  Keypair,
  SystemProgram,
  type SignatureStatus,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { SolanaChainHandler } from './solana-chain-handler.js';

/**
 * #169: a Solana broadcast waits for confirmation before it returns, so the
 * moment the node accepted the bytes has to come from the send itself, not
 * from when broadcast() returned. Offline: the node is a fake that accepts
 * the bytes, reports nothing on the first poll and confirmed on the next.
 */
describe('Solana broadcast sentAt (#169)', () => {
  it('reports when the node accepted the bytes, before the poll that saw them confirmed', async () => {
    const payer = Keypair.generate();
    const tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: bs58.encode(Buffer.alloc(32, 7)),
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    tx.sign(payer);
    const signed = tx.serialize().toString('base64');

    let acceptedAt: Date | undefined;
    let confirmedSeenAt: Date | undefined;
    let polls = 0;
    const connection = {
      getBlockHeight: () => Promise.resolve(1_000),
      sendRawTransaction: () => {
        acceptedAt ??= new Date();
        return Promise.resolve(bs58.encode(tx.signature!));
      },
      getSignatureStatuses: () => {
        polls += 1;
        if (polls < 2) return Promise.resolve({ context: { slot: 1 }, value: [null] });
        confirmedSeenAt = new Date();
        const status: SignatureStatus = {
          slot: 2,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed',
        };
        return Promise.resolve({ context: { slot: 2 }, value: [status] });
      },
    } as unknown as Connection;

    const handler = new SolanaChainHandler({
      connection,
      senderAddress: payer.publicKey.toBase58(),
    });
    const result = await handler.broadcast(signed);
    const returnedAt = new Date();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hash).toBe(bs58.encode(tx.signature!));
    const sentAt = result.value.sentAt;
    expect(sentAt).toBeInstanceOf(Date);
    expect(sentAt!.getTime()).toBeGreaterThanOrEqual(acceptedAt!.getTime());
    expect(sentAt!.getTime()).toBeLessThan(confirmedSeenAt!.getTime());
    expect(sentAt!.getTime()).toBeLessThan(returnedAt.getTime());
  });
});
