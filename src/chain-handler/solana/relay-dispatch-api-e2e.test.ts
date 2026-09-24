import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { ChainRegistry } from '../../chain-registry/chain-registry.js';
import { Coordinator } from '../../coordinator/coordinator.js';
import type { Chain } from '../../domain/chain.js';
import { InMemoryDispatchStore } from '../../repository/in-memory-dispatch-store.js';
import { SignerClient } from '../../signer/client.js';
import { SOLANA_ABANDONMENT_TIMEOUT_MS, SolanaChainHandler } from './solana-chain-handler.js';
import { getDevnetConnection, getFundedSenderKeypair } from './test-support/devnet-fixtures.js';

/**
 * relay-dispatch issue 01's primary acceptance seam (its own Testing
 * Decisions): the real HTTP API driving a real Coordinator, a real
 * in-memory DispatchStore, and the real SolanaChainHandler on real devnet —
 * exactly dispatch-api-e2e.test.ts's own shape, extended to `mode:
 * "relay"`. Unlike that file, no reference-signer/SignerClient is started
 * for the relayed transaction itself: it's signed entirely outside the
 * engine, by a keypair the engine never sees. A SignerClient is still
 * constructed for SolanaChainHandler's own required deps, but nothing in
 * this file ever calls it — Relay Dispatch never signs anything.
 */

const AUTH_TOKEN = 'test-token';
const CHAIN: Chain = 'solana';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RelayGetResponseBody = {
  dispatchId: string;
  mode: string;
  status: string;
  transactionHash: string | null;
  error: { code?: string; message?: string } | null;
};

async function driveRelayToTerminal(
  coordinator: Coordinator,
  app: ReturnType<typeof buildApp>,
  dispatchId: string,
  timeoutMs = 30_000,
): Promise<RelayGetResponseBody> {
  await coordinator.processQueuedRelayDispatches(10);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await coordinator.pollPendingTransactions(50);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatchId}`,
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const body = response.json<RelayGetResponseBody>();
    if (body.status === 'confirmed' || body.status === 'failed' || body.status === 'abandoned') {
      return body;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `relay dispatch ${dispatchId} did not reach a terminal state within ${timeoutMs}ms`,
      );
    }
    await sleep(1_500);
  }
}

describe('Solana Relay Dispatch — full API end to end (real devnet)', () => {
  it('broadcasts, confirms, and independently verifies a transaction signed entirely outside the engine', async () => {
    const sender = await getFundedSenderKeypair();
    const connection = getDevnetConnection();

    // Signed entirely outside the engine: plain web3.js, the cached test
    // wallet's own secret key, no SolanaChainHandler.sign/SignerClient
    // involved anywhere in producing these bytes — the engine only ever
    // sees the resulting signed transaction, exactly as a Relay Dispatch
    // caller's own wallet would produce it. Reuses the already-funded
    // shared sender rather than airdropping a fresh keypair, since devnet's
    // faucet is rate-limited and this suite already funds that one wallet.
    const recipient = Keypair.generate();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: sender.publicKey, blockhash, lastValidBlockHeight });
    tx.add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 1_000_000,
      }),
    );
    tx.sign(sender);
    const signedTransaction = tx
      .serialize({ requireAllSignatures: true, verifySignatures: false })
      .toString('base64');

    const store = new InMemoryDispatchStore();
    const chainRegistry = await ChainRegistry.load([CHAIN], {
      solana: () =>
        Promise.resolve(
          new SolanaChainHandler({
            connection,
            signerClient: new SignerClient('http://127.0.0.1:1'), // never called — Relay Dispatch signs nothing
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

    const postResponse = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        'idempotency-key': `relay-e2e-${Date.now()}`,
      },
      payload: { chain: CHAIN, mode: 'relay', signedTransaction },
    });

    expect(postResponse.statusCode).toBe(202);
    const { dispatchId } = postResponse.json<{ dispatchId: string; status: string }>();

    const coordinator = new Coordinator({
      store,
      chainHandlers: chainRegistry.handlers,
      senderAddresses: new Map([[CHAIN, sender.publicKey.toBase58()]]),
      abandonmentTimeoutMs: new Map([[CHAIN, SOLANA_ABANDONMENT_TIMEOUT_MS]]),
    });

    const body = await driveRelayToTerminal(coordinator, app, dispatchId);

    expect(body.mode).toBe('relay');
    expect(body.status).toBe('confirmed');
    expect(body.transactionHash).toEqual(expect.any(String));
    expect(body.error).toBeNull();

    // Independent, real-chain proof — not just the engine's own bookkeeping.
    const recipientBalance = await connection.getBalance(recipient.publicKey);
    expect(recipientBalance).toBe(1_000_000);
  }, 60_000);

  it('rejects a malformed signed transaction with 400 and never persists it', async () => {
    const sender = await getFundedSenderKeypair();
    const connection = getDevnetConnection();

    const store = new InMemoryDispatchStore();
    const chainRegistry = await ChainRegistry.load([CHAIN], {
      solana: () =>
        Promise.resolve(
          new SolanaChainHandler({
            connection,
            signerClient: new SignerClient('http://127.0.0.1:1'),
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

    const idempotencyKey = `relay-e2e-malformed-${Date.now()}`;
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, 'idempotency-key': idempotencyKey },
      payload: { chain: CHAIN, mode: 'relay', signedTransaction: 'not-real-signed-bytes' },
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ code?: string }>().code).toBe('CHAIN_REJECTED');

    // Never persisted: resubmitting the same key with a genuinely valid
    // payload must succeed fresh, not idempotently return the rejected one.
    // Reuses the shared funded sender (no fresh airdrop) — see the happy-
    // path test's own comment for why.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: sender.publicKey, blockhash, lastValidBlockHeight });
    tx.add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1_000,
      }),
    );
    tx.sign(sender);
    const validSignedTransaction = tx
      .serialize({ requireAllSignatures: true, verifySignatures: false })
      .toString('base64');

    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, 'idempotency-key': idempotencyKey },
      payload: { chain: CHAIN, mode: 'relay', signedTransaction: validSignedTransaction },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json<{ status: string }>().status).toBe('queued');
  }, 30_000);
});
