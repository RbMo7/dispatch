import { Keypair } from '@solana/web3.js';
import { afterAll, describe, expect, it } from 'vitest';

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

const PAYMENTS = 40; // 5 bundles of 8
const LAMPORTS = 1_000_000n;

/** #42 (ADR-0044), real devnet: a batch through the Coordinator, sent 1 and 4 at a time. */
describe('Solana concurrent sends through the Coordinator (#42)', () => {
  let signer: TestSignerHandle | undefined;

  afterAll(async () => {
    await signer?.close();
  });

  async function payout(maxConcurrentSends: number): Promise<number> {
    const sender = await getFundedSenderKeypair();
    signer ??= await startTestSigner([sender]);
    const connection = getDevnetConnection();
    const senderAddress = sender.publicKey.toBase58();
    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url),
      senderAddress,
      maxConcurrentSends,
    });
    const recipients = Array.from({ length: PAYMENTS }, () => Keypair.generate().publicKey);
    const items = [];
    for (const recipient of recipients) {
      const payment = {
        recipient: recipient.toBase58(),
        asset: 'SOL',
        amount: LAMPORTS.toString(),
      };
      const call = await handler.paymentToCall(payment);
      if (!call.ok) throw new Error('paymentToCall failed');
      items.push({ call: call.value, payment });
    }
    const store = new InMemoryDispatchStore();
    const dispatch = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: `concurrent-${maxConcurrentSends}-${Date.now()}`,
      items,
      retryPolicy: false,
    });
    const coordinator = new Coordinator({
      store,
      chainHandlers: new Map([['solana', handler]]),
      senderAddresses: new Map([['solana', senderAddress]]),
      abandonmentTimeoutMs: new Map([['solana', SOLANA_ABANDONMENT_TIMEOUT_MS]]),
    });

    const started = Date.now();
    await coordinator.processQueuedDispatches(10); // broadcast waits for confirmation
    const elapsed = Date.now() - started;

    const rows = await store.listTransactions(dispatch.id);
    expect(rows).toHaveLength(PAYMENTS);
    expect(new Set(rows.map((t) => t.hash)).size).toBe(PAYMENTS / 8);
    await coordinator.pollPendingTransactions(PAYMENTS);
    expect((await store.listTransactions(dispatch.id)).every((t) => t.status === 'CONFIRMED')).toBe(
      true,
    );
    const balances = await connection.getMultipleAccountsInfo(recipients);
    expect(balances.every((info) => BigInt(info?.lamports ?? 0) === LAMPORTS)).toBe(true);
    return elapsed;
  }

  it('pays every recipient exactly once, one bundle at a time or four', async () => {
    const sequentialMs = await payout(1);
    const concurrentMs = await payout(4);
    console.log(
      `#42: ${PAYMENTS} payments, 5 bundles — sequential ${sequentialMs}ms, concurrent(4) ${concurrentMs}ms`,
    );
  }, 240_000);
});
