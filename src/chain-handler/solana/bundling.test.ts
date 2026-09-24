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
 * issue 10 — proves bundling actually works, not just that the chunking
 * math is right (that's covered by the size measurement documented next to
 * MAX_BUNDLE_SIZE). Calls `prepare` directly with several Calls at once:
 * the Coordinator itself never does this yet (it drives one Call through
 * prepare/sign/broadcast at a time — see coordinator.ts), which is exactly
 * why this issue needs its own test rather than relying on end-to-end
 * Dispatch processing.
 */
describe('SolanaChainHandler bundling', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it('bundles multiple Calls into one real transaction: one signature, one broadcast, every recipient paid exactly once', async () => {
    const sender = await getFundedSenderKeypair();
    const recipients = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();

    let signCallCount = 0;
    const countingSignerClient = new SignerClient(signer.url);
    const realRequestSignature = countingSignerClient.requestSignature.bind(countingSignerClient);
    countingSignerClient.requestSignature = (request) => {
      signCallCount++;
      return realRequestSignature(request);
    };

    const handler = new SolanaChainHandler({
      connection,
      signerClient: countingSignerClient,
      senderAddress: sender.publicKey.toBase58(),
    });

    const calls = [];
    for (const recipient of recipients) {
      const callResult = await handler.paymentToCall({
        recipient: recipient.publicKey.toBase58(),
        asset: 'SOL',
        amount: '2000000',
      });
      expect(callResult.ok).toBe(true);
      if (!callResult.ok) return;
      calls.push(callResult.value);
    }

    const prepareResult = await handler.prepare(calls, sender.publicKey.toBase58());
    expect(prepareResult.ok).toBe(true);
    if (!prepareResult.ok) return;
    expect(prepareResult.value).toHaveLength(3);
    const unsignedTransactions = new Set(prepareResult.value.map((p) => p.unsignedTransaction));
    expect(unsignedTransactions.size).toBe(1); // all 3 share one bundle

    const signedResults = await Promise.all(
      prepareResult.value.map((p) => handler.sign(p, sender.publicKey.toBase58())),
    );
    expect(signedResults.every((r) => r.ok)).toBe(true);
    const signedBytes = new Set(signedResults.map((r) => (r.ok ? r.value : undefined)));
    expect(signedBytes.size).toBe(1); // identical signed bytes — one real signature for the whole bundle
    expect(signCallCount).toBe(1); // the Signer was only ever asked once

    const broadcastResults = await Promise.all(
      signedResults.map((r) =>
        r.ok ? handler.broadcast(r.value) : Promise.reject(new Error('unreachable')),
      ),
    );
    expect(broadcastResults.every((r) => r.ok)).toBe(true);
    const hashes = new Set(broadcastResults.map((r) => (r.ok ? r.value.hash : undefined)));
    expect(hashes.size).toBe(1); // same underlying transaction — Solana's own signature-based dedup makes resubmission a no-op

    const [hash] = hashes;
    if (!hash) return;
    const latest = await connection.getLatestBlockhash('confirmed');
    const confirmation = await connection.confirmTransaction(
      { signature: hash, ...latest },
      'confirmed',
    );
    expect(confirmation.value.err).toBeNull();

    for (const recipient of recipients) {
      const balance = await connection.getBalance(recipient.publicKey);
      expect(balance).toBe(2_000_000); // paid exactly once each, not zero, not twice
    }
  }, 30_000);
});
