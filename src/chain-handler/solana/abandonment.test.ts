import { Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/devnet-fixtures.js';

/**
 * issue 08's decision (ADR-0030, ADR-0042): Solana never needs ABANDONED —
 * a transaction whose blockhash has provably expired without ever
 * confirming resolves to a definitive EXPIRED. Deliberately real and slow
 * (ADR-0013), same as the blockhash-refresh test: this one holds a signed
 * transaction *unbroadcast* until its blockhash genuinely expires, so
 * getSignatureStatuses genuinely finds nothing and isBlockhashValid
 * genuinely returns false — no mocked timeout standing in for either.
 */
describe('SolanaChainHandler.getStatus provable-expiry resolution (issue 08)', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it('reports EXPIRED, never leaves it PENDING forever, once the signed blockhash is provably expired and nothing was ever broadcast — also from a fresh instance given the bytes via restoreInFlight', async () => {
    const sender = await getFundedSenderKeypair();
    const recipient = Keypair.generate();
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();

    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url),
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

    const decoded = Transaction.from(Buffer.from(signResult.value, 'base64'));
    const blockhash = decoded.recentBlockhash;
    const hash = decoded.signature ? bs58.encode(decoded.signature) : undefined;
    expect(blockhash).toBeTruthy();
    expect(hash).toBeTruthy();
    if (!blockhash || !hash) return;

    const deadline = Date.now() + 150_000;
    let stillValid = true;
    while (Date.now() < deadline) {
      ({ value: stillValid } = await connection.isBlockhashValid(blockhash, {
        commitment: 'confirmed',
      }));
      if (!stillValid) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    expect(stillValid).toBe(false);

    // Never broadcast at all — getStatus must still resolve this to
    // EXPIRED on its own, once the block height is past its last valid one
    // plus the lagging-node margin (a minute or so after isBlockhashValid).
    const settle = async (h: SolanaChainHandler) => {
      const deadline = Date.now() + 300_000;
      for (;;) {
        const status = await h.getStatus(hash);
        if (!status.ok || status.value !== 'PENDING' || Date.now() > deadline) return status;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    };
    const status = await settle(handler);

    expect(status.ok).toBe(true);
    expect(status.ok && status.value).toBe('EXPIRED');

    // #33 (ADR-0042): a restarted worker's fresh instance has no record
    // until restoreInFlight hands it the in-flight bytes.
    const restarted = new SolanaChainHandler({
      connection,
      senderAddress: sender.publicKey.toBase58(),
    });
    const before = await restarted.getStatus(hash);
    expect(before.ok && before.value).toBe('PENDING');
    await restarted.restoreInFlight([signResult.value]);
    const after = await settle(restarted); // a restored bound is conservative: proven later, never earlier
    expect(after.ok && after.value).toBe('EXPIRED');
  }, 900_000);

  it('leaves a hash it has no blockhash bookkeeping for as PENDING rather than guessing FAILED', async () => {
    const handler = new SolanaChainHandler({
      connection: getDevnetConnection(),
      signerClient: new SignerClient('http://127.0.0.1:1'),
      senderAddress: Keypair.generate().publicKey.toBase58(),
    });
    const result = await handler.getStatus(bs58.encode(Buffer.alloc(64, 9)));

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe('PENDING');
  });
});
