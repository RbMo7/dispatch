import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import { getDevnetConnection, getFundedSenderKeypair } from './test-support/devnet-fixtures.js';

/**
 * issue 15/ADR-0033: `broadcast` must derive the same blockhash bookkeeping
 * for a transaction it never itself signed (a Relay Dispatch transaction)
 * that `sign` already gives a self-signed one — so `getStatus`'s
 * provable-expiry resolution (ADR-0030, ADR-0042) holds
 * identically regardless of who produced the signature. Mirrors
 * abandonment.test.ts's own "hold it unbroadcast until it genuinely
 * expires" strategy (ADR-0013: real and slow, no mocked timeout standing in
 * for either `isBlockhashValid` or `getSignatureStatuses`), but signs
 * entirely outside the engine and drives the expiry check through
 * `broadcast` itself rather than `getStatus` directly — `broadcast` is the
 * only place bookkeeping for these bytes gets created at all.
 */
describe('SolanaChainHandler.broadcast bookkeeping for externally-signed transactions (issue 15)', () => {
  it('derives bookkeeping from the signed bytes alone, and resolves a provably-expired externally-signed transaction to EXPIRED — never resigning, never leaving it PENDING forever', async () => {
    const sender = await getFundedSenderKeypair();
    const connection = getDevnetConnection();

    // Signed entirely outside the engine — no handler.sign, no SignerClient
    // call for these bytes at all. Reuses the shared funded sender (no
    // fresh airdrop) purely as a real, spendable fee payer; devnet's faucet
    // is rate-limited and this suite already funds this one wallet.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: sender.publicKey, blockhash, lastValidBlockHeight });
    tx.add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1_000_000,
      }),
    );
    tx.sign(sender);
    const signed = tx
      .serialize({ requireAllSignatures: true, verifySignatures: false })
      .toString('base64');
    const hash = tx.signature ? bs58.encode(tx.signature) : undefined;
    expect(hash).toBeTruthy();
    if (!hash) return;

    // Handler that never signed this transaction — its SignerClient would
    // fail if `broadcast` ever wrongly attempted to resign with it.
    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient('http://127.0.0.1:1'), // never called
      senderAddress: sender.publicKey.toBase58(),
    });

    const deadline = Date.now() + 150_000;
    let stillValid = true;
    while (Date.now() < deadline) {
      ({ value: stillValid } = await connection.isBlockhashValid(blockhash, {
        commitment: 'confirmed',
      }));
      if (!stillValid) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    expect(stillValid).toBe(false); // sanity check the wait actually worked before trusting what follows

    // Only now attempt to send — genuinely expired, so the send itself is
    // refused ("Blockhash not found"). broadcast must not attempt to resign
    // (it has no key for `sender` beyond what this test itself holds): it
    // hands off with the same hash (ADR-0042), having recorded bookkeeping
    // for `hash` despite the send itself failing.
    const broadcastResult = await handler.broadcast(signed);
    expect(broadcastResult.ok && broadcastResult.value.hash).toBe(hash);

    const status = await handler.getStatus(hash);
    expect(status.ok).toBe(true);
    expect(status.ok && status.value).toBe('EXPIRED');
  }, 600_000); // broadcast waits out a conservative expiry bound for bytes it never signed

  it('confirms an externally-signed transaction the same way as a self-signed one, proving bookkeeping was really recorded for bytes this handler never signed', async () => {
    const sender = await getFundedSenderKeypair();
    const connection = getDevnetConnection();

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: sender.publicKey, blockhash, lastValidBlockHeight });
    tx.add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1_000_000,
      }),
    );
    tx.sign(sender);
    const signed = tx
      .serialize({ requireAllSignatures: true, verifySignatures: false })
      .toString('base64');

    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient('http://127.0.0.1:1'),
      senderAddress: sender.publicKey.toBase58(),
    });

    const broadcastResult = await handler.broadcast(signed);
    expect(broadcastResult.ok).toBe(true);
    if (!broadcastResult.ok) return;

    // broadcast() itself already polled to confirmation before returning ok
    // (pollUntilConfirmedOrExpired, HTTP-only) — an independent getStatus
    // call afterward must agree, proving bookkeeping was really recorded
    // for bytes this handler never signed, not just that the send worked.
    const status = await handler.getStatus(broadcastResult.value.hash);
    expect(status.ok).toBe(true);
    expect(status.ok && status.value).toBe('CONFIRMED');
  }, 30_000);
});
