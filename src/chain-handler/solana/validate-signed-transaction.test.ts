import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import { SolanaChainHandler } from './solana-chain-handler.js';

/**
 * issue 14: a pure local decode/crypto check (ADR-0032) — no RPC involved,
 * so unlike the rest of this directory's tests, this one never needs real
 * devnet. `connection`/`signerClient` are constructed but deliberately
 * never called.
 */
function buildHandler(): SolanaChainHandler {
  return new SolanaChainHandler({
    connection: new Connection('http://127.0.0.1:1'),
    signerClient: new SignerClient('http://127.0.0.1:1'),
    senderAddress: Keypair.generate().publicKey.toBase58(),
  });
}

function buildSignedTransaction(feePayer: Keypair): Transaction {
  const tx = new Transaction({
    feePayer: feePayer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1,
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: feePayer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1_000,
    }),
  );
  tx.sign(feePayer);
  return tx;
}

describe('SolanaChainHandler.validateSignedTransaction', () => {
  it('accepts a genuinely, correctly signed transaction', async () => {
    const handler = buildHandler();
    const feePayer = Keypair.generate();
    const signed = buildSignedTransaction(feePayer)
      .serialize({ requireAllSignatures: true, verifySignatures: false })
      .toString('base64');

    const result = await handler.validateSignedTransaction(signed);

    expect(result.ok).toBe(true);
  });

  it('rejects a transaction whose signature has been tampered with', async () => {
    const handler = buildHandler();
    const feePayer = Keypair.generate();
    const raw = buildSignedTransaction(feePayer).serialize({
      requireAllSignatures: true,
      verifySignatures: false,
    });
    raw.writeUInt8(raw.readUInt8(10) ^ 0xff, 10); // corrupt a byte inside the first (and only) signature

    const result = await handler.validateSignedTransaction(raw.toString('base64'));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toEqual(expect.any(String));
  });

  it('rejects garbage bytes with a structured error, never throwing', async () => {
    const handler = buildHandler();

    const result = await handler.validateSignedTransaction('not-real-signed-bytes');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toEqual(expect.any(String));
  });

  it('never mutates the signed bytes it is given', async () => {
    const handler = buildHandler();
    const feePayer = Keypair.generate();
    const signed = buildSignedTransaction(feePayer)
      .serialize({ requireAllSignatures: true, verifySignatures: false })
      .toString('base64');
    const before = signed;

    await handler.validateSignedTransaction(signed);

    expect(signed).toBe(before);
  });
});
