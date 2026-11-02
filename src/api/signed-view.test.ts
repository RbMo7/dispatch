import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { feeOf, relaySignedView } from './signed-view.js';
import { buildTimeline } from './timeline.js';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const vault = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';

async function signedBase(overrides: { maxFeePerGas?: bigint } = {}) {
  return account.signTransaction({
    type: 'eip1559',
    chainId: 84532,
    nonce: 3,
    to: vault,
    value: 1_000_000_000_000n,
    gas: 21_000n,
    maxFeePerGas: overrides.maxFeePerGas ?? 2_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
  });
}

describe('feeOf', () => {
  it('reads the EIP-1559 fees a Base version was signed with', async () => {
    expect(feeOf('base', await signedBase({ maxFeePerGas: 3_500_000_000n }))).toEqual({
      maxFeePerGas: '3500000000',
      maxPriorityFeePerGas: '100000000',
    });
  });

  it('reads base64 bytes too, as a relay caller sends them', async () => {
    const hex = await signedBase();
    const base64 = Buffer.from(hex.slice(2), 'hex').toString('base64');
    expect(feeOf('base', base64)?.maxFeePerGas).toBe('2000000000');
  });

  it('says nothing for Solana, unsent versions or bytes it cannot read', () => {
    expect(feeOf('solana', 'AQID')).toBeUndefined();
    expect(feeOf('base', null)).toBeUndefined();
    expect(feeOf('base', '0x1234')).toBeUndefined();
  });
});

describe('relaySignedView', () => {
  it('names the Base signer, the target and the value', async () => {
    expect(await relaySignedView('base', await signedBase())).toEqual({
      signer: account.address,
      target: vault,
      value: { asset: 'ETH', amount: '1000000000000', decimals: 18 },
    });
  });

  function signedSolana(instructions: TransactionInstruction[]) {
    const payer = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    return { payer, signed: Buffer.from(tx.serialize()).toString('base64') };
  }

  it('reads a Solana transfer past its Compute Budget instructions', async () => {
    const recipient = Keypair.generate().publicKey;
    const payer = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient,
          lamports: 1_500_000,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    expect(await relaySignedView('solana', Buffer.from(tx.serialize()).toString('base64'))).toEqual(
      {
        signer: payer.publicKey.toBase58(),
        target: recipient.toBase58(),
        value: { asset: 'SOL', amount: '1500000', decimals: 9 },
      },
    );
  });

  it('names the program of any other Solana call, with no value', async () => {
    const memo = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const { payer, signed } = signedSolana([
      { programId: memo, keys: [], data: Buffer.from('hello') },
    ]);
    expect(await relaySignedView('solana', signed)).toEqual({
      signer: payer.publicKey.toBase58(),
      target: memo.toBase58(),
    });
  });

  it('reads nothing from bytes that are not a transaction', async () => {
    expect(await relaySignedView('base', 'not bytes')).toEqual({});
    expect(await relaySignedView('solana', 'AQID')).toEqual({});
  });
});

describe('the timeline of a fee bump', () => {
  it('gives each Base version the fees it was signed with', async () => {
    const at = new Date('2026-11-02T00:00:00Z');
    const row = (id: string, hash: string, signedBytes: string, replaces: string | null) =>
      ({
        id,
        dispatchId: 'd',
        callIndex: 0,
        chain: 'base',
        hash,
        signedBytes,
        status: replaces ? 'CONFIRMED' : 'REPLACED',
        error: null,
        broadcastAt: at,
        abandonedAt: null,
        confirmedAt: replaces ? at : null,
        failedAt: null,
        lastCheckedAt: null,
        lastBroadcastAt: at,
        sentAt: null,
        replacesTransactionId: replaces,
        feeBumpAttempts: replaces ? 1 : 0,
        proposalId: null,
        proposalPosition: null,
      }) as const;
    const timeline = buildTimeline({
      dispatch: { createdAt: at, firstClaimedAt: at, cancelledAt: null },
      transactions: [
        row('t1', '0xaa', await signedBase({ maxFeePerGas: 1_000_000_000n }), null),
        row('t2', '0xbb', await signedBase({ maxFeePerGas: 1_250_000_000n }), 't1'),
      ],
      attempts: [],
      proposals: [],
    });

    expect(
      timeline.flatMap((e) => (e.kind === 'written' ? [[e.hash, e.fee?.maxFeePerGas]] : [])),
    ).toEqual([
      ['0xaa', '1000000000'],
      ['0xbb', '1250000000'],
    ]);
  });
});
