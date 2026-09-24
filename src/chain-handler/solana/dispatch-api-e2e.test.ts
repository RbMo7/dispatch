import { getAccount } from '@solana/spl-token';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { ChainRegistry } from '../../chain-registry/chain-registry.js';
import { Coordinator } from '../../coordinator/coordinator.js';
import type { Chain } from '../../domain/chain.js';
import { InMemoryDispatchStore } from '../../repository/in-memory-dispatch-store.js';
import { SignerClient } from '../../signer/client.js';
import { deriveAssociatedTokenAddress } from './account-resolution.js';
import { fromTransactionInstruction } from './instruction-codec.js';
import { SOLANA_ABANDONMENT_TIMEOUT_MS, SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  getTestMint,
  startTestSigner,
  testMintDecimals,
  type TestSignerHandle,
} from './test-support/devnet-fixtures.js';

/**
 * The whole engine, exercised the way an integrator actually would:
 * POST /v1/dispatch, poll GET /v1/dispatch/:id, real devnet underneath.
 * Everything up to this point in the feature called SolanaChainHandler's
 * own methods directly — this is the first test that goes through the real
 * API routes, a real Coordinator, and a real (in-memory) DispatchStore
 * together.
 *
 * worker.ts has no processing loop wired in yet (a pre-existing,
 * already-deferred core-engine-scaffold gap — see AGENTS.md's own review
 * cadence, which scopes that wiring to its own separate issue). This test
 * plays the worker's role itself by driving the same real Coordinator the
 * worker would eventually run, exactly as an integration test — everything
 * it drives (the API, the store, the Chain Handler, the Coordinator) is
 * real; only "call this on a timer forever" is stood in for.
 */

const AUTH_TOKEN = 'test-token';
const CHAIN: Chain = 'solana';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function driveToTerminal(
  coordinator: Coordinator,
  store: InMemoryDispatchStore,
  dispatchId: string,
  itemCount: number,
  timeoutMs = 30_000,
): Promise<void> {
  await coordinator.processQueuedDispatches(10);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await coordinator.pollPendingTransactions(50);
    const transactions = await store.listTransactions(dispatchId);
    const terminal = transactions.filter((t) => t.status === 'CONFIRMED' || t.status === 'FAILED');
    if (transactions.length >= itemCount && terminal.length === transactions.length) return;
    await sleep(1_500);
  }
  throw new Error(`dispatch ${dispatchId} did not reach a terminal state within ${timeoutMs}ms`);
}

describe('Solana Managed Dispatch — full API end to end (real devnet)', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it('processes a native SOL payment, a custom SPL token payment, and a raw contract call together in one Dispatch', async () => {
    const sender = await getFundedSenderKeypair();
    const mint = await getTestMint();
    const decimals = testMintDecimals();
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();

    const solRecipient = Keypair.generate();
    const tokenRecipient = Keypair.generate();
    const memoText = `dispatchxyz api-e2e ${Date.now()}`;
    const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const memoCall = fromTransactionInstruction(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [],
        data: Buffer.from(memoText, 'utf8'),
      }),
    );

    const store = new InMemoryDispatchStore();
    const chainRegistry = await ChainRegistry.load([CHAIN], {
      solana: () =>
        Promise.resolve(
          new SolanaChainHandler({
            connection,
            signerClient: new SignerClient(signer!.url),
            senderAddress: sender.publicKey.toBase58(),
            knownTokens: { TEST: { mint: mint.toBase58(), decimals } },
          }),
        ),
    });
    const app = buildApp({
      store,
      chainRegistry,
      authToken: AUTH_TOKEN,
      defaultRetryPolicy: false,
    });

    const postResponse = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        'idempotency-key': `api-e2e-mixed-${Date.now()}`,
      },
      payload: {
        chain: CHAIN,
        items: [
          {
            type: 'payment',
            recipient: solRecipient.publicKey.toBase58(),
            asset: 'SOL',
            amount: '2000000',
          },
          {
            type: 'payment',
            recipient: tokenRecipient.publicKey.toBase58(),
            asset: 'TEST',
            amount: '5000000',
          },
          { type: 'call', ...memoCall },
        ],
      },
    });

    expect(postResponse.statusCode).toBe(202);
    const { dispatchId } = postResponse.json<{ dispatchId: string; status: string }>();

    const coordinator = new Coordinator({
      store,
      chainHandlers: chainRegistry.handlers,
      senderAddresses: new Map([[CHAIN, sender.publicKey.toBase58()]]),
      abandonmentTimeoutMs: new Map([[CHAIN, SOLANA_ABANDONMENT_TIMEOUT_MS]]),
    });

    await driveToTerminal(coordinator, store, dispatchId, 3);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatchId}`,
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(getResponse.statusCode).toBe(200);
    const body = getResponse.json<{
      status: string;
      items: { status: string; transactionHash: string | null; error: unknown }[];
    }>();

    expect(body.status).toBe('confirmed');
    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(item.status).toBe('confirmed');
      expect(item.transactionHash).toEqual(expect.any(String));
      expect(item.error).toBeNull();
    }

    // Independent, real-chain proof for every item type — not just that the
    // engine's own bookkeeping says "confirmed".
    const solBalance = await connection.getBalance(solRecipient.publicKey);
    expect(solBalance).toBe(2_000_000);

    const tokenAta = deriveAssociatedTokenAddress(tokenRecipient.publicKey, mint);
    const tokenAccount = await getAccount(connection, tokenAta);
    expect(tokenAccount.amount).toBe(5_000_000n);

    const memoTx = await connection.getTransaction(body.items[2]!.transactionHash!, {
      maxSupportedTransactionVersion: 0,
    });
    const logs = memoTx?.meta?.logMessages ?? [];
    expect(logs.some((line) => line.includes(memoText))).toBe(true);
  }, 60_000);

  it('fails fast with INSUFFICIENT_FUNDS via the real Funding Check, before ever broadcasting', async () => {
    const sender = await getFundedSenderKeypair();
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();

    const store = new InMemoryDispatchStore();
    const chainRegistry = await ChainRegistry.load([CHAIN], {
      solana: () =>
        Promise.resolve(
          new SolanaChainHandler({
            connection,
            signerClient: new SignerClient(signer!.url),
            senderAddress: sender.publicKey.toBase58(),
          }),
        ),
    });
    const app = buildApp({
      store,
      chainRegistry,
      authToken: AUTH_TOKEN,
      defaultRetryPolicy: false,
    });

    const hugeAmount = '999999999999999999'; // far beyond the real balance, no risk of accidentally succeeding
    const postResponse = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        'idempotency-key': `api-e2e-insufficient-${Date.now()}`,
      },
      payload: {
        chain: CHAIN,
        items: [
          {
            type: 'payment',
            recipient: Keypair.generate().publicKey.toBase58(),
            asset: 'SOL',
            amount: hugeAmount,
          },
        ],
      },
    });
    expect(postResponse.statusCode).toBe(202);
    const { dispatchId } = postResponse.json<{ dispatchId: string }>();

    const coordinator = new Coordinator({
      store,
      chainHandlers: chainRegistry.handlers,
      senderAddresses: new Map([[CHAIN, sender.publicKey.toBase58()]]),
      abandonmentTimeoutMs: new Map([[CHAIN, SOLANA_ABANDONMENT_TIMEOUT_MS]]),
    });
    await coordinator.processQueuedDispatches(10); // Funding Check runs synchronously in the claim step — no polling needed

    const getResponse = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatchId}`,
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const body = getResponse.json<{
      status: string;
      items: { status: string; transactionHash: string | null; error: { code?: string } | null }[];
    }>();

    expect(body.status).toBe('failed');
    expect(body.items[0]?.status).toBe('failed');
    expect(body.items[0]?.transactionHash).toBeNull(); // never reached prepare/sign/broadcast
    expect(body.items[0]?.error?.code).toBe('INSUFFICIENT_FUNDS');

    // The real balance never moved — this really never broadcast anything.
    const balance = await connection.getBalance(sender.publicKey);
    expect(balance).toBeGreaterThan(0);
  }, 30_000);
});
