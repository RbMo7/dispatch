import { Keypair } from '@solana/web3.js';
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
 * Deliberately slow and real (ADR-0013, issue 06's own instruction: "this
 * needs an actual scenario that forces a stale/expiring blockhash, not just
 * a mocked timeout"). Signs a transaction, holds it unbroadcast until its
 * blockhash has genuinely expired (~60-90s on devnet — polled via
 * `isBlockhashValid` rather than a blind sleep), then broadcasts it: the
 * first send genuinely fails with devnet's real "Blockhash not found", and
 * `broadcast()` must refresh the blockhash and resubmit as a new
 * Transaction rather than surfacing that as a terminal failure.
 */
describe('SolanaChainHandler.broadcast blockhash-refresh-and-resubmit', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it(
    'resubmits with a fresh blockhash and still lands, after the originally-signed blockhash expires',
    async () => {
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
      expect(prepareResult.ok).toBe(true);
      if (!prepareResult.ok) return;
      const prepared = prepareResult.value[0];
      expect(prepared).toBeDefined();
      if (!prepared) return;

      const signResult = await handler.sign(prepared, sender.publicKey.toBase58());
      expect(signResult.ok).toBe(true);
      if (!signResult.ok) return;

      const signedBytes = Buffer.from(signResult.value, 'base64');
      const { Transaction } = await import('@solana/web3.js');
      const decoded = Transaction.from(signedBytes);
      const originalBlockhash = decoded.recentBlockhash;
      expect(originalBlockhash).toBeTruthy();
      if (!originalBlockhash) return;

      const deadline = Date.now() + 150_000;
      let stillValid = true;
      while (Date.now() < deadline) {
        ({ value: stillValid } = await connection.isBlockhashValid(originalBlockhash, {
          commitment: 'confirmed',
        }));
        if (!stillValid) break;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      expect(stillValid).toBe(false); // sanity check the wait actually worked before trusting what follows

      const broadcastResult = await handler.broadcast(signResult.value);

      expect(broadcastResult.ok).toBe(true);
      if (!broadcastResult.ok) return;

      const latest = await connection.getLatestBlockhash('confirmed');
      const confirmation = await connection.confirmTransaction(
        { signature: broadcastResult.value.hash, ...latest },
        'confirmed',
      );
      expect(confirmation.value.err).toBeNull();

      const recipientBalance = await connection.getBalance(recipient.publicKey);
      expect(recipientBalance).toBe(2_000_000);
    },
    180_000,
  );
});
