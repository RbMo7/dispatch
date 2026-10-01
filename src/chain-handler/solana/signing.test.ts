import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/devnet-fixtures.js';

describe('SolanaChainHandler.sign', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it('fetches a real recent blockhash and produces a transaction the network accepts as validly signed', async () => {
    const sender = await getFundedSenderKeypair();
    const recipient = Keypair.generate().publicKey;
    signer = await startTestSigner([sender]);

    const handler = new SolanaChainHandler({
      connection: getDevnetConnection(),
      signerClient: new SignerClient(signer.url, signer.token),
      senderAddress: sender.publicKey.toBase58(),
    });

    const callResult = await handler.paymentToCall({
      recipient: recipient.toBase58(),
      asset: 'SOL',
      amount: '1000',
    });
    expect(callResult.ok).toBe(true);
    if (!callResult.ok) return;

    const prepareResult = await handler.prepare([callResult.value], sender.publicKey.toBase58());
    expect(prepareResult.ok).toBe(true);
    if (!prepareResult.ok) return;
    const prepared = prepareResult.value[0];
    expect(prepared).toBeDefined();
    if (!prepared) return;

    const signResult = await handler.sign(prepared, sender.publicKey.toBase58());

    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    // A real, independent verification: decode the signed bytes with web3.js
    // itself and check the signature validates against the compiled message
    // — proof the Signer's ed25519 signature is actually correct, not just
    // that our own code thinks it is.
    const decoded = Transaction.from(Buffer.from(signResult.value, 'base64'));
    expect(decoded.verifySignatures()).toBe(true);
    expect(decoded.feePayer?.toBase58()).toBe(sender.publicKey.toBase58());
  });

  it('never mutates the PreparedTransaction it is given', async () => {
    const sender = await getFundedSenderKeypair();
    const recipient = Keypair.generate().publicKey;
    signer = await startTestSigner([sender]);

    const handler = new SolanaChainHandler({
      connection: getDevnetConnection(),
      signerClient: new SignerClient(signer.url, signer.token),
      senderAddress: sender.publicKey.toBase58(),
    });

    const callResult = await handler.paymentToCall({
      recipient: recipient.toBase58(),
      asset: 'SOL',
      amount: '1000',
    });
    expect(callResult.ok).toBe(true);
    if (!callResult.ok) return;
    const prepareResult = await handler.prepare([callResult.value], sender.publicKey.toBase58());
    expect(prepareResult.ok).toBe(true);
    if (!prepareResult.ok) return;
    const prepared = prepareResult.value[0];
    expect(prepared).toBeDefined();
    if (!prepared) return;
    const before = structuredClone(prepared);

    await handler.sign(prepared, sender.publicKey.toBase58());

    expect(prepared).toEqual(before);
  });

  it('surfaces SIGNER_UNREACHABLE as a structured error when the signer is unreachable, not a thrown exception', async () => {
    const sender = await getFundedSenderKeypair();
    const recipient = Keypair.generate().publicKey;

    const handler = new SolanaChainHandler({
      connection: getDevnetConnection(),
      signerClient: new SignerClient('http://127.0.0.1:1', undefined), // nothing listens here
      senderAddress: sender.publicKey.toBase58(),
    });

    const callResult = await handler.paymentToCall({
      recipient: recipient.toBase58(),
      asset: 'SOL',
      amount: '1000',
    });
    expect(callResult.ok).toBe(true);
    if (!callResult.ok) return;
    const prepareResult = await handler.prepare([callResult.value], sender.publicKey.toBase58());
    expect(prepareResult.ok).toBe(true);
    if (!prepareResult.ok) return;
    const prepared = prepareResult.value[0];
    expect(prepared).toBeDefined();
    if (!prepared) return;

    const result = await handler.sign(prepared, sender.publicKey.toBase58());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('SIGNER_UNREACHABLE');
  });

  it('surfaces SIGNER_UNREACHABLE when no Signer is configured at all, without ever touching the network — a Relay-Dispatch-only deployment never needs one', async () => {
    const sender = Keypair.generate();
    const recipient = Keypair.generate().publicKey;

    const handler = new SolanaChainHandler({
      connection: new Connection('http://127.0.0.1:1'), // never called
      // signerClient omitted entirely
      senderAddress: sender.publicKey.toBase58(),
    });

    const callResult = await handler.paymentToCall({
      recipient: recipient.toBase58(),
      asset: 'SOL',
      amount: '1000',
    });
    expect(callResult.ok).toBe(true);
    if (!callResult.ok) return;
    const prepareResult = await handler.prepare([callResult.value], sender.publicKey.toBase58());
    expect(prepareResult.ok).toBe(true);
    if (!prepareResult.ok) return;
    const prepared = prepareResult.value[0];
    expect(prepared).toBeDefined();
    if (!prepared) return;

    const result = await handler.sign(prepared, sender.publicKey.toBase58());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('SIGNER_UNREACHABLE');
  });
});
