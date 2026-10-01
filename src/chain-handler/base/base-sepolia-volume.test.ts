import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { ChainRegistry } from '../../chain-registry/chain-registry.js';
import { Coordinator } from '../../coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { BASE_ABANDONMENT_TIMEOUT_MS, BaseChainHandler } from './base-chain-handler.js';
import {
  acquireDevSenderLock,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  DEV_SENDER_LOCK_HOOK_TIMEOUT_MS,
  getDevSenderAccount,
  getOrDeployTestAggregator,
  getOrDeployTestToken,
  startTestSigner,
  type TestSignerHandle,
  type TestTokenInfo,
} from './test-support/base-fixtures.js';
import { decodeUnsignedTransaction, encodeUnsignedTransaction } from './transaction-codec.js';

/**
 * #15 — the actual proof base-chain-handler is done, mirroring
 * solana-chain-handler issue 12's devnet volume test: one real run against
 * real Base Sepolia (ADR-0013) — no fake chain behavior anywhere — driving
 * sequential Managed Dispatch, Bulk Call and a real fee-bump together, then
 * auditing the Sender's whole nonce sequence against the chain itself.
 *
 * It spends real (testnet) ETH, so it only runs when asked:
 * RUN_BASE_VOLUME=1 (ADR-0040). Solana's devnet run is opt-in the same way.
 */
const RUN = process.env.RUN_BASE_VOLUME === '1';
const TRACE_RPC_URL = process.env.BASE_TRACE_RPC_URL ?? '';
const AUTH_TOKEN = 'test-token';

const NATIVE_COUNT = 80;
const ERC20_COUNT = 15;
const RAW_CALL_COUNT = 5;
const NATIVE_AMOUNT = 1000n; // wei
const TOKEN_AMOUNT = 1n; // smallest TestToken unit
/** Short, so the underpriced transaction is judged stuck within the run rather than after the production 60s. */
const STUCK_AFTER_MS = 10_000;
/** How long to wait for an on-chain read (a balance, the nonce) to catch up with a confirmed receipt. */
const SETTLE_MS = 60_000;

type ItemBody = { status: string; transactionHash: string | null };
type GetBody = { status: string; items: ItemBody[] };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(1_000);
    value = await read();
  }
  return value;
}

describe.runIf(RUN)('Base Sepolia volume run (#15)', () => {
  const sender = getDevSenderAccount();
  const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
  let testSigner: TestSignerHandle;
  let releaseDevSenderLock: () => Promise<void>;
  let token: TestTokenInfo;
  let aggregator: `0x${string}`;
  let handler: BaseChainHandler;
  let store: InMemoryDispatchStore;
  let coordinator: Coordinator;
  let app: ReturnType<typeof buildApp>;
  let startNonce: number;

  beforeAll(async () => {
    releaseDevSenderLock = await acquireDevSenderLock();
    testSigner = await startTestSigner([sender]);
    token = await getOrDeployTestToken();
    aggregator = await getOrDeployTestAggregator();
    handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      signerClient: new SignerClient(testSigner.url),
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
      knownTokens: { TEST: { contractAddress: token.address, decimals: token.decimals } },
      ...(TRACE_RPC_URL ? { traceRpcUrl: TRACE_RPC_URL } : {}),
    });
    store = new InMemoryDispatchStore();
    const chainRegistry = await ChainRegistry.load(['base'], {
      base: () => Promise.resolve(handler),
    });
    app = buildApp({ store, chainRegistry, authToken: AUTH_TOKEN, defaultRetryPolicy: false });
    coordinator = new Coordinator({
      store,
      chainHandlers: chainRegistry.handlers,
      senderAddresses: new Map([['base', sender.address]]),
      abandonmentTimeoutMs: new Map([['base', BASE_ABANDONMENT_TIMEOUT_MS]]),
      stuckHandling: new Map([['base', { stuckAfterMs: STUCK_AFTER_MS, maxFeeBumps: 3 }]]),
    });
    // The audit accounts for every nonce from here on, so start from a Sender
    // with nothing pending — e.g. no leftover from a crashed earlier run.
    const settled = await eventually(
      async () => {
        const [latest, pending] = await Promise.all([
          client.getTransactionCount({ address: sender.address, blockTag: 'latest' }),
          client.getTransactionCount({ address: sender.address, blockTag: 'pending' }),
        ]);
        return { latest, pending };
      },
      ({ latest, pending }) => latest === pending,
      SETTLE_MS,
    );
    if (settled.latest !== settled.pending) {
      throw new Error(
        `dev-sender has ${settled.pending - settled.latest} transaction(s) still pending — the nonce audit can't start until they land`,
      );
    }
    startNonce = settled.latest;
  }, DEV_SENDER_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await testSigner?.close();
    await releaseDevSenderLock?.();
  });

  async function post(payload: object): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        'idempotency-key': `volume-${Date.now()}-${Math.random()}`,
      },
      payload: { chain: 'base', ...payload },
    });
    expect(response.statusCode).toBe(202);
    return response.json<{ dispatchId: string }>().dispatchId;
  }

  async function get(dispatchId: string): Promise<GetBody> {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatchId}`,
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    return response.json<GetBody>();
  }

  /** Polls until every item of every given Dispatch is terminal. */
  async function settle(dispatchIds: string[], timeoutMs: number): Promise<GetBody[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await coordinator.pollPendingTransactions(200);
      const bodies = await Promise.all(dispatchIds.map(get));
      const open = bodies.some((b) =>
        b.items.some((i) => i.status === 'queued' || i.status === 'broadcasting'),
      );
      if (!open || Date.now() > deadline) return bodies;
      await sleep(2_000);
    }
  }

  // Shared across the ordered steps below: what each produced, for the final audit.
  const dispatchIds: string[] = [];
  const directHashes: string[] = [];
  const balanceOf = (address: `0x${string}`) =>
    client.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    });

  it(
    `step 1: ${NATIVE_COUNT + ERC20_COUNT + RAW_CALL_COUNT} sequential payments and two default Bulk Call bundles, through the real API — every item correct on-chain`,
    async () => {
      // --- 1. A large sequential Managed Dispatch: native, ERC-20, raw calls ---
      const nativeRecipients = Array.from({ length: NATIVE_COUNT }, () =>
        privateKeyToAddress(generatePrivateKey()),
      );
      const tokenRecipients = Array.from({ length: ERC20_COUNT }, () =>
        privateKeyToAddress(generatePrivateKey()),
      );
      const countBefore = (await client.readContract({
        address: token.address,
        abi: token.abi,
        functionName: 'count',
      })) as bigint;
      const increment = encodeFunctionData({ abi: token.abi, functionName: 'increment' });
      const sequentialId = await post({
        items: [
          ...nativeRecipients.map((recipient) => ({
            type: 'payment',
            recipient,
            asset: 'ETH',
            amount: NATIVE_AMOUNT.toString(),
          })),
          ...tokenRecipients.map((recipient) => ({
            type: 'payment',
            recipient,
            asset: 'TEST',
            amount: TOKEN_AMOUNT.toString(),
          })),
          ...Array.from({ length: RAW_CALL_COUNT }, () => ({
            type: 'call',
            to: token.address,
            data: increment,
            value: '0',
          })),
        ],
      });

      // --- 2. Bulk Call through a caller-owned aggregator (default allowFailure: false) ---
      const bulkNative = privateKeyToAddress(generatePrivateKey());
      const bulkToken = privateKeyToAddress(generatePrivateKey());
      const bulkWholeId = await post({
        bulkCall: { aggregator },
        items: [
          {
            type: 'payment',
            recipient: bulkNative,
            asset: 'ETH',
            amount: NATIVE_AMOUNT.toString(),
          },
          { type: 'payment', recipient: bulkToken, asset: 'TEST', amount: TOKEN_AMOUNT.toString() },
          { type: 'call', to: token.address, data: increment, value: '0' },
        ],
      });
      const bulkRevertedNative = privateKeyToAddress(generatePrivateKey());
      const bulkRevertedId = await post({
        bulkCall: { aggregator },
        items: [
          {
            type: 'payment',
            recipient: bulkRevertedNative,
            asset: 'ETH',
            amount: NATIVE_AMOUNT.toString(),
          },
          {
            type: 'call',
            to: token.address,
            data: encodeFunctionData({ abi: token.abi, functionName: 'revertAlways' }),
            value: '0',
          },
        ],
      });
      // Per-item isolation inside one bundle needs a trace (ADR-0038).
      const isolatedNative = privateKeyToAddress(generatePrivateKey());
      const bulkIsolatedId = TRACE_RPC_URL
        ? await post({
            bulkCall: { aggregator, allowFailure: true },
            items: [
              {
                type: 'payment',
                recipient: isolatedNative,
                asset: 'ETH',
                amount: NATIVE_AMOUNT.toString(),
              },
              {
                type: 'call',
                to: token.address,
                data: encodeFunctionData({ abi: token.abi, functionName: 'revertAlways' }),
                value: '0',
              },
            ],
          })
        : undefined;

      await coordinator.processQueuedDispatches(10);
      const ids = [
        sequentialId,
        bulkWholeId,
        bulkRevertedId,
        ...(bulkIsolatedId ? [bulkIsolatedId] : []),
      ];
      const [sequential, bulkWhole, bulkReverted, bulkIsolated] = await settle(ids, 5 * 60_000);

      expect(sequential?.status).toBe('confirmed');
      expect(sequential?.items.every((i) => i.status === 'confirmed')).toBe(true);
      expect(bulkWhole?.items.map((i) => i.status)).toEqual([
        'confirmed',
        'confirmed',
        'confirmed',
      ]);
      expect(bulkReverted?.items.map((i) => i.status)).toEqual(['failed', 'failed']);
      if (bulkIsolated)
        expect(bulkIsolated.items.map((i) => i.status)).toEqual(['confirmed', 'failed']);
      dispatchIds.push(...ids);

      for (const recipient of [...nativeRecipients, bulkNative]) {
        expect(
          await eventually(
            () => client.getBalance({ address: recipient }),
            (b) => b === NATIVE_AMOUNT,
            SETTLE_MS,
          ),
        ).toBe(NATIVE_AMOUNT);
      }
      for (const recipient of [...tokenRecipients, bulkToken]) {
        expect(
          await eventually(
            () => balanceOf(recipient),
            (b) => b === TOKEN_AMOUNT,
            SETTLE_MS,
          ),
        ).toBe(TOKEN_AMOUNT);
      }
      expect(await client.getBalance({ address: bulkRevertedNative })).toBe(0n);
      const [revertedRow] = await store.listTransactions(bulkRevertedId);
      expect((await client.getTransactionReceipt({ hash: revertedRow!.hash as Hex })).status).toBe(
        'reverted',
      );
      if (bulkIsolatedId) {
        expect(
          await eventually(
            () => client.getBalance({ address: isolatedNative }),
            (b) => b === NATIVE_AMOUNT,
            SETTLE_MS,
          ),
        ).toBe(NATIVE_AMOUNT);
      }
      expect(
        await client.readContract({
          address: token.address,
          abi: token.abi,
          functionName: 'count',
        }),
      ).toBe(
        countBefore + BigInt(RAW_CALL_COUNT) + 1n, // + the whole-bundle's increment
      );
    },
    10 * 60_000,
  );

  it(
    'step 2: an allowFailure: true bundle with a mixed outcome — one slot lands, one fails, the bundle stands (on-chain)',
    async () => {
      // A mixed-outcome bundle — one item lands, one fails, the bundle stands
      // (allowFailure: true) — sent straight through the handler, so its
      // outcome is proven on-chain without needing a tracing RPC.
      const mixedNative = privateKeyToAddress(generatePrivateKey());
      const mixedToken = privateKeyToAddress(generatePrivateKey());
      const mixedPrepared = await handler.prepare(
        [
          { to: mixedNative, data: '0x', value: NATIVE_AMOUNT.toString() },
          {
            to: token.address,
            // More than the aggregator holds: this slot must fail.
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [mixedToken, 10n ** 30n],
            }),
            value: '0',
          },
        ],
        sender.address,
        { bulkCall: { aggregator, maxBatchSize: 50, allowFailure: true } },
      );
      if (!mixedPrepared.ok || !mixedPrepared.value[0])
        throw new Error('mixed bundle prepare failed');
      const mixedSigned = await handler.sign(mixedPrepared.value[0], sender.address);
      if (!mixedSigned.ok)
        throw new Error(`mixed bundle sign failed: ${JSON.stringify(mixedSigned.error)}`);
      const mixedSent = await handler.broadcast(mixedSigned.value);
      if (!mixedSent.ok)
        throw new Error(`mixed bundle broadcast failed: ${JSON.stringify(mixedSent.error)}`);
      const mixedReceipt = await client.waitForTransactionReceipt({
        hash: mixedSent.value.hash as Hex,
      });
      expect(mixedReceipt.status).toBe('success'); // the failing slot didn't take the bundle down
      directHashes.push(mixedSent.value.hash);
      expect(
        await eventually(
          () => client.getBalance({ address: mixedNative }),
          (b) => b === NATIVE_AMOUNT,
          SETTLE_MS,
        ),
      ).toBe(NATIVE_AMOUNT); // the mixed bundle's succeeding slot landed…
      expect(await balanceOf(mixedToken)).toBe(0n); // …and its failing slot did not
    },
    3 * 60_000,
  );

  it(
    'step 3: a deliberately underpriced transaction is judged stuck, fee-bumped at the same nonce, and the replacement confirms',
    async () => {
      // --- 3. A real fee-bump: an underpriced transaction, bumped by the Coordinator ---
      // Last in the run: while it's stuck, nothing later from the Sender could land.
      const block = await client.getBlock();
      // Just below the base fee: never mineable, yet as close to a normal fee
      // as possible so a node at its fee floor doesn't refuse it outright.
      const underpricedCap = block.baseFeePerGas! > 1n ? block.baseFeePerGas! - 1n : 1n;
      const bumpRecipient = privateKeyToAddress(generatePrivateKey());
      const bumpCall = { to: bumpRecipient, data: '0x', value: NATIVE_AMOUNT.toString() };
      const prepared = await handler.prepare([bumpCall], sender.address);
      if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
      const underpricedUnsigned = encodeUnsignedTransaction({
        ...decodeUnsignedTransaction(prepared.value[0].unsignedTransaction),
        maxFeePerGas: underpricedCap.toString(),
        maxPriorityFeePerGas: (underpricedCap < 1_000_000n
          ? underpricedCap
          : 1_000_000n
        ).toString(),
      }); // nonce left for sign to assign, so the handler's own counter stays authoritative
      const signed = await handler.sign(
        { callIndex: 0, unsignedTransaction: underpricedUnsigned },
        sender.address,
      );
      if (!signed.ok) throw new Error(`sign failed: ${JSON.stringify(signed.error)}`);
      const sent = await handler.broadcast(signed.value);
      if (!sent.ok) throw new Error(`underpriced broadcast failed: ${JSON.stringify(sent.error)}`);
      const bumpDispatch = await store.createDispatch({
        chain: 'base',
        idempotencyKey: `volume-bump-${Date.now()}`,
        items: [{ call: bumpCall, payment: null }], // the very Call the underpriced transaction carries
        retryPolicy: true,
      });
      await store.claimQueued(10);
      const original = await store.createTransaction({
        dispatchId: bumpDispatch.id,
        callIndex: 0,
        chain: 'base',
        signedBytes: signed.value,
        hash: sent.value.hash,
      });
      const [bumpBody] = await settle([bumpDispatch.id], 3 * 60_000);
      expect(bumpBody?.items[0]?.status).toBe('confirmed');
      const bumpRows = (await store.listTransactions(bumpDispatch.id)).filter(
        (t) => t.callIndex === 0,
      );
      expect(bumpRows.length).toBeGreaterThan(1); // at least one real replacement
      expect(store.getTransaction(original.id)?.status).toBe('DROPPED');
      dispatchIds.push(bumpDispatch.id);
      expect(
        await eventually(
          () => client.getBalance({ address: bumpRecipient }),
          (b) => b === NATIVE_AMOUNT,
          SETTLE_MS,
        ),
      ).toBe(NATIVE_AMOUNT); // the fee-bumped payment itself arrived
    },
    5 * 60_000,
  );

  it(
    "step 4: the Sender's whole nonce sequence is gapless and collision-free against the chain itself",
    async () => {
      // Everything the handler ever assigned must be mined: the chain's count
      // has to reach the handler's own next nonce — a tail gap would stop it short.
      const expectedEnd = handler.peekNextNonce();
      const endNonce = await eventually(
        () => client.getTransactionCount({ address: sender.address, blockTag: 'latest' }),
        (n) => n >= expectedEnd,
        SETTLE_MS,
      );
      expect(endNonce).toBe(expectedEnd);
      const hashes = new Set<string>(directHashes);
      for (const id of dispatchIds) {
        for (const t of await store.listTransactions(id)) if (t.hash) hashes.add(t.hash);
      }
      const landedNonces: number[] = [];
      for (const hash of hashes) {
        const receipt = await client
          .getTransactionReceipt({ hash: hash as Hex })
          .catch((cause: unknown) => {
            if (cause instanceof TransactionReceiptNotFoundError) return null; // a fee-bump version that never landed
            throw cause; // anything else is an RPC problem, not evidence
          });
        if (!receipt) continue;
        const tx = await client.getTransaction({ hash: hash as Hex });
        expect(tx.from.toLowerCase()).toBe(sender.address.toLowerCase());
        landedNonces.push(tx.nonce);
      }
      landedNonces.sort((a, b) => a - b);
      // Gapless and collision-free: exactly one landed transaction per nonce the Sender used in this run.
      expect(landedNonces).toEqual(
        Array.from({ length: endNonce - startNonce }, (_, i) => startNonce + i),
      );
    },
    3 * 60_000,
  );
});
