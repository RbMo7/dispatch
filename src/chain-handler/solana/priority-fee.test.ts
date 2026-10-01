import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import type { SolanaCall } from '../../domain/call.js';
import { SignerClient } from '../../signer/client.js';
import { priorityFeeEstimate, SolanaChainHandler } from './solana-chain-handler.js';
import { buildSplTransferCall } from './spl-transfer.js';

const sender = Keypair.generate().publicKey.toBase58();

function handlerWith(computeUnitPriceMicroLamports?: number) {
  return new SolanaChainHandler({
    connection: new Connection('http://127.0.0.1:1'), // prepare never touches the network
    senderAddress: sender,
    ...(computeUnitPriceMicroLamports === undefined ? {} : { computeUnitPriceMicroLamports }),
  });
}

/** SPL payments (create-ATA + transferChecked each) to distinct recipients — each of a distinct mint unless one is given: the worst case. */
function splCalls(count: number, mint?: string): SolanaCall[] {
  return Array.from({ length: count }, () => {
    const call = buildSplTransferCall(
      sender,
      Keypair.generate().publicKey.toBase58(),
      mint ?? Keypair.generate().publicKey.toBase58(),
      6,
      1n,
    );
    if (!call.ok) throw new Error('buildSplTransferCall failed');
    return call.value;
  });
}

/** Test-only peek at this handler's own opaque encoding (ADR-0027). */
function instructionsOf(unsigned: string): TransactionInstruction[] {
  const encoded = JSON.parse(Buffer.from(unsigned, 'base64').toString('utf8')) as {
    instructions: {
      programId: string;
      keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
      data: string;
    }[];
  };
  return encoded.instructions.map(
    (i) =>
      new TransactionInstruction({
        programId: new PublicKey(i.programId),
        keys: i.keys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
        data: Buffer.from(i.data, 'base64'),
      }),
  );
}

describe('SolanaChainHandler priority fee (#34)', () => {
  it('adds nothing by default — a priority fee costs more, so it is opt-in (ADR-0003)', async () => {
    const prepared = await handlerWith().prepare(splCalls(1), sender);
    if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
    const programs = instructionsOf(prepared.value[0].unsignedTransaction).map((i) =>
      i.programId.toBase58(),
    );
    expect(programs).not.toContain(ComputeBudgetProgram.programId.toBase58());
  });

  it('prepends a compute-unit limit and price to each bundle, and splits a bundle before it would pass 1232 bytes', async () => {
    const prepared = await handlerWith(5_000).prepare(splCalls(8), sender);
    if (!prepared.ok) throw new Error('prepare failed');
    expect(prepared.value.map((p) => p.callIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const bundles = [...new Set(prepared.value.map((p) => p.unsignedTransaction))];
    expect(bundles.length).toBeGreaterThan(1); // 8 distinct-mint SPL payments can't share one transaction

    for (const bundle of bundles) {
      const instructions = instructionsOf(bundle);
      // A placeholder SetComputeUnitLimit (sign swaps in simulated usage, #37), then SetComputeUnitPrice.
      expect(
        instructions
          .slice(0, 2)
          .map((i) => [i.programId.equals(ComputeBudgetProgram.programId), i.data[0]]),
      ).toEqual([
        [true, 2],
        [true, 3],
      ]);
      expect(
        instructions.filter((i) => i.programId.equals(ComputeBudgetProgram.programId)),
      ).toHaveLength(2);
      const tx = new Transaction({
        feePayer: new PublicKey(sender),
        blockhash: Keypair.generate().publicKey.toBase58(), // any 32 bytes: size only
        lastValidBlockHeight: 0,
      }).add(...instructions);
      expect(1 + 64 + tx.compileMessage().serialize().length).toBeLessThanOrEqual(1232);
    }
  });

  it('still bundles 8 payments of one mint into a single transaction', async () => {
    const prepared = await handlerWith(5_000).prepare(
      splCalls(8, Keypair.generate().publicKey.toBase58()),
      sender,
    );
    if (!prepared.ok) throw new Error('prepare failed');
    expect(new Set(prepared.value.map((p) => p.unsignedTransaction)).size).toBe(1);
  });

  it('refuses to sign a single Call too big for one transaction — a structured error, never a throw', async () => {
    const handler = new SolanaChainHandler({
      connection: new Connection('http://127.0.0.1:1'),
      signerClient: new SignerClient('http://127.0.0.1:1', undefined), // never reached
      senderAddress: sender,
    });
    const huge: SolanaCall = {
      programId: sender,
      accounts: [],
      data: Buffer.alloc(1300).toString('base64'),
    };
    const prepared = await handler.prepare([huge], sender);
    if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');

    const signed = await handler.sign(prepared.value[0], sender);

    expect(!signed.ok && signed.error.code).toBe('CHAIN_REJECTED');
    expect(!signed.ok && signed.error.message).toMatch(/1232-byte limit/);
  });

  it('refuses a price that is not a whole, non-negative number of micro-lamports', () => {
    expect(() => handlerWith(1.5)).toThrow(/compute-unit price/);
    expect(() => handlerWith(-1)).toThrow(/compute-unit price/);
  });

  describe('auto (#43)', () => {
    it('takes the 75th percentile of recent fees, never above the ceiling', () => {
      expect(priorityFeeEstimate([0, 10, 20, 30, 40, 50, 60, 70], 1_000)).toBe(50);
      expect(priorityFeeEstimate([100, 5_000, 9_000, 9_500], 2_000)).toBe(2_000);
      expect(priorityFeeEstimate([], 2_000)).toBe(0);
    });

    it('refuses to start without a ceiling', () => {
      const connection = new Connection('http://127.0.0.1:1');
      expect(
        () =>
          new SolanaChainHandler({
            connection,
            senderAddress: sender,
            computeUnitPriceMicroLamports: 'auto',
          }),
      ).toThrow(/ceiling/);
    });

    it('reserves the ceiling in prepare, like a fixed price', async () => {
      const handler = new SolanaChainHandler({
        connection: new Connection('http://127.0.0.1:1'),
        senderAddress: sender,
        computeUnitPriceMicroLamports: 'auto',
        maxComputeUnitPriceMicroLamports: 7_000,
      });
      const prepared = await handler.prepare(splCalls(1), sender);
      if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
      const price = instructionsOf(prepared.value[0].unsignedTransaction)[1];
      expect(price?.data.readBigUInt64LE(1)).toBe(7_000n);
    });
  });
});
