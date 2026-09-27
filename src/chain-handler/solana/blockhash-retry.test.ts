import { Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../../coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../../repository/in-memory-dispatch-store.js';
import { SignerClient } from '../../signer/client.js';
import { SOLANA_ABANDONMENT_TIMEOUT_MS, SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/devnet-fixtures.js';

/**
 * ADR-0042 (#32, #33), deliberately slow and real (ADR-0013): a worker
 * wrote a transaction down, then crashed before it landed, and restarts
 * after its blockhash expired. A fresh handler re-learns the blockhash
 * (`restoreReservations` -> `restoreInFlight`), `getStatus` proves it
 * EXPIRED, and the Coordinator resubmits the Call as a new Transaction —
 * written down before it is sent — that actually pays the recipient once.
 */
describe('Solana resubmission of a provably expired transaction after a restart (ADR-0042)', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it('resubmits the expired Call with a fresh blockhash, and it lands exactly once', async () => {
    const sender = await getFundedSenderKeypair();
    const senderAddress = sender.publicKey.toBase58();
    const recipient = Keypair.generate();
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();
    const newHandler = () =>
      new SolanaChainHandler({
        connection,
        signerClient: new SignerClient(signer!.url),
        senderAddress,
      });

    // Before the crash: the Call is prepared, signed and written down, never sent.
    const beforeCrash = newHandler();
    const call = await beforeCrash.paymentToCall({
      recipient: recipient.publicKey.toBase58(),
      asset: 'SOL',
      amount: '2000000',
    });
    if (!call.ok) throw new Error('paymentToCall failed');
    const prepared = await beforeCrash.prepare([call.value], senderAddress);
    if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
    const signed = await beforeCrash.sign(prepared.value[0], senderAddress);
    if (!signed.ok) throw new Error('sign failed');
    const decoded = Transaction.from(Buffer.from(signed.value, 'base64'));
    if (!decoded.recentBlockhash || !decoded.signature) throw new Error('unsigned transaction');
    const originalHash = bs58.encode(decoded.signature);

    const store = new InMemoryDispatchStore();
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: `expiry-${Date.now()}`,
      items: [{ call: call.value, payment: null }],
      retryPolicy: false,
    });
    await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'solana',
      signedBytes: signed.value,
      hash: originalHash,
    });

    const deadline = Date.now() + 150_000;
    let stillValid = true;
    while (Date.now() < deadline) {
      ({ value: stillValid } = await connection.isBlockhashValid(decoded.recentBlockhash, {
        commitment: 'confirmed',
      }));
      if (!stillValid) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    expect(stillValid).toBe(false); // sanity check the wait actually worked before trusting what follows

    // After the restart: a fresh handler, restored from the store.
    const coordinator = new Coordinator({
      store,
      chainHandlers: new Map([['solana', newHandler()]]),
      senderAddresses: new Map([['solana', senderAddress]]),
      abandonmentTimeoutMs: new Map([['solana', SOLANA_ABANDONMENT_TIMEOUT_MS]]),
    });
    await coordinator.restoreReservations();
    await coordinator.pollPendingTransactions(10); // EXPIRED -> resubmitted; broadcast waits for confirmation
    await coordinator.pollPendingTransactions(10); // the resubmission confirms

    const rows = await store.listTransactions(dispatch.id);
    expect(rows.map((t) => t.status)).toEqual(['DROPPED', 'CONFIRMED']);
    expect(rows[1]?.hash).not.toBe(originalHash);
    expect(await connection.getBalance(recipient.publicKey)).toBe(2_000_000);
  }, 240_000);
});
