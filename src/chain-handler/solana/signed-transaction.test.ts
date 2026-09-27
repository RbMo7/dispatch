import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { SolanaChainHandler } from './solana-chain-handler.js';

const payer = Keypair.generate();
const blockhash = Keypair.generate().publicKey.toBase58(); // any 32 bytes: nothing here touches the network
const handler = new SolanaChainHandler({
  connection: new Connection('http://127.0.0.1:1'),
  senderAddress: payer.publicKey.toBase58(),
});

function v0(signers: Keypair[], extraSigner?: Keypair): VersionedTransaction {
  const instructions = [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  ];
  if (extraSigner) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: extraSigner.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1,
      }),
    );
  }
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(),
  );
  if (signers.length > 0) tx.sign(signers);
  return tx;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** #36: signed bytes are decoded as legacy and versioned (v0) alike — no network. */
describe('SolanaChainHandler signed-transaction decoding (#36)', () => {
  it('accepts a signed v0 transaction and reports its fee-payer signature as its hash', async () => {
    const tx = v0([payer]);
    expect(await handler.validateSignedTransaction(b64(tx.serialize()))).toEqual({
      ok: true,
      value: undefined,
    });
    expect(handler.transactionHash(b64(tx.serialize()))).toEqual({
      ok: true,
      value: bs58.encode(tx.signatures[0]!),
    });
  });

  it('still accepts a signed legacy transaction', async () => {
    const tx = new Transaction({
      feePayer: payer.publicKey,
      blockhash,
      lastValidBlockHeight: 0,
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    tx.sign(payer);
    const signed = tx.serialize().toString('base64');
    expect(await handler.validateSignedTransaction(signed)).toEqual({ ok: true, value: undefined });
    expect(handler.transactionHash(signed)).toEqual({
      ok: true,
      value: bs58.encode(tx.signature!),
    });
  });

  it('refuses an unsigned v0 transaction', async () => {
    const result = await handler.validateSignedTransaction(b64(v0([]).serialize()));
    expect(!result.ok && result.error.message).toMatch(/no signature/);
    expect(handler.transactionHash(b64(v0([]).serialize())).ok).toBe(false);
  });

  it('refuses a v0 transaction altered after signing', async () => {
    const bytes = v0([payer]).serialize();
    bytes[bytes.length - 2]! ^= 0xff; // the transfer amount (the last byte is the lookup-table count)
    const result = await handler.validateSignedTransaction(b64(bytes));
    expect(!result.ok && result.error.message).toMatch(/does not cryptographically verify/);
  });

  it('refuses a v0 transaction missing one of its required signatures', async () => {
    const other = Keypair.generate();
    const tx = v0([], other);
    tx.sign([payer]); // only the fee payer signs
    const result = await handler.validateSignedTransaction(b64(tx.serialize()));
    expect(!result.ok && result.error.message).toMatch(/does not cryptographically verify/);
  });
});
