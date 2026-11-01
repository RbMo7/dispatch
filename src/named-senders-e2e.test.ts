import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { createPublicClient, createWalletClient, http, type Chain as ViemChain } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import {
  acquireDevSenderLock,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  DEV_SENDER_LOCK_HOOK_TIMEOUT_MS,
  getDevSenderAccount,
  startTestSigner as startBaseSigner,
} from './chain-handler/base/test-support/base-fixtures.js';
import {
  DEVNET_RPC_URL,
  getDevnetConnection,
  getFundedSenderKeypair,
  startTestSigner as startSolanaSigner,
} from './chain-handler/solana/test-support/devnet-fixtures.js';
import { sendAndConfirm } from './chain-handler/solana/test-support/squads-e2e-fixtures.js';
import type { Chain } from './domain/chain.js';

/**
 * Live (ADR-0013), opt-in: RUN_NAMED_SENDERS=1. Two plain Senders on one
 * chain (ADR-0060), through the whole engine: a senders file, the real
 * loaders, the real Postgres test database, the real API and a Coordinator
 * driven the way the worker drives it, one claim per Sender. The default
 * Sender's broadcast is held back until the other Sender's Dispatch has
 * confirmed, so the run shows a stuck Sender does not delay another. Spends
 * a little devnet SOL and Base Sepolia ETH from the dev Senders.
 */
const RUN = process.env.RUN_NAMED_SENDERS === '1';
const API_TOKEN = 'test-token';
const log = (message: string) => console.log(`[named-senders-e2e] ${message}`);

type WireDispatch = {
  status: string;
  sender?: { name: string | null; address: string };
  items: { status: string; transactionHash: string | null }[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function engineFor(chain: Chain, env: Record<string, string>, senders: object) {
  const dir = mkdtempSync(path.join(tmpdir(), 'named-senders-'));
  const sendersFile = path.join(dir, 'senders.json');
  writeFileSync(sendersFile, JSON.stringify({ [chain]: senders }));
  Object.assign(process.env, { ENABLED_CHAINS: chain, SENDERS_FILE: sendersFile, ...env });
  vi.resetModules();
  const loaders = await import('./chain-loaders.js');
  const { Coordinator } = await import('./coordinator/coordinator.js');
  const { db } = await import('./db/client.js');
  const { PostgresDispatchStore } = await import('./repository/postgres-dispatch-store.js');
  const { buildApp } = await import('./app.js');
  const { cachedSenders } = await import('./api/senders.js');

  const registry = await loaders.loadChainRegistry(loaders.workerSignerClient());
  const store = new PostgresDispatchStore(db);
  const config = loaders.coordinatorConfigFor(registry);
  const coordinator = new Coordinator({
    store,
    chainHandlers: registry.handlers,
    senders: config.senders,
    abandonmentTimeoutMs: config.abandonmentTimeoutMs,
    reorgRecheckWindowMs: config.reorgRecheckWindowMs,
    stuckHandling: config.stuckHandling,
  });
  await coordinator.assignUnassignedDispatches();
  await coordinator.restoreReservations();
  const assetDecimals = loaders.assetDecimalsFromConfig();
  const app = buildApp({
    store,
    chainRegistry: registry,
    authToken: API_TOKEN,
    defaultRetryPolicy: false,
    assetDecimals,
    listSenders: cachedSenders(
      await loaders.senderConfigsFor(registry, assetDecimals),
      loaders.senderReadsFor(registry, store),
    ),
  });
  const post = async (payload: object) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        'idempotency-key': `named-senders-${chain}-${Date.now()}-${Math.random()}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(202);
    return response.json<{ dispatchId: string }>().dispatchId;
  };
  const get = async <T>(url: string) =>
    (
      await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${API_TOKEN}` } })
    ).json<T>();
  return { registry, coordinator, post, get };
}

/**
 * Sends one Dispatch from each Sender in one run. The default Sender's
 * broadcast waits until the other's Dispatch is confirmed (or two minutes
 * pass); each Sender is claimed on its own, as the worker's loops do.
 */
async function sendThroughBoth(
  engine: Awaited<ReturnType<typeof engineFor>>,
  chain: Chain,
  payment: (recipient: string) => object,
  recipients: [string, string],
) {
  const { registry, coordinator, post, get } = engine;
  const [payouts, refunds] = registry.senders;
  if (!payouts?.address || !refunds?.address) throw new Error('two Senders expected');
  const events: string[] = [];
  const t0 = Date.now();
  const at = (event: string) => events.push(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${event}`);

  let refundsConfirmed = false;
  const held = payouts.handler;
  const broadcast = held.broadcast.bind(held);
  held.broadcast = async (signed) => {
    at('payouts: broadcast held back');
    const until = Date.now() + 120_000;
    while (!refundsConfirmed && Date.now() < until) await sleep(500);
    at('payouts: broadcast released');
    return broadcast(signed);
  };

  const toPayouts = await post({ chain, items: [payment(recipients[0])] });
  const toRefunds = await post({ chain, sender: 'refunds', items: [payment(recipients[1])] });
  at('both Dispatches accepted');

  const payoutsLoop = coordinator
    .processQueuedDispatchesFor({ chain, address: payouts.address }, 10)
    .then(() => at('payouts: claim tick done'));
  await coordinator.processQueuedDispatchesFor({ chain, address: refunds.address }, 10);
  at('refunds: claim tick done');

  const deadline = Date.now() + 180_000;
  let heldWhenRefundsConfirmed = false;
  for (;;) {
    await coordinator.pollPendingTransactions(20);
    const [p, r] = await Promise.all([
      get<WireDispatch>(`/v1/dispatch/${toPayouts}`),
      get<WireDispatch>(`/v1/dispatch/${toRefunds}`),
    ]);
    if (!refundsConfirmed && r.status === 'confirmed') {
      heldWhenRefundsConfirmed = p.items[0]?.status !== 'confirmed';
      refundsConfirmed = true;
      at(`refunds: confirmed ${r.items[0]?.transactionHash} while payouts is ${p.status}`);
    }
    if (p.status === 'confirmed' && r.status === 'confirmed') {
      at(`payouts: confirmed ${p.items[0]?.transactionHash}`);
      await payoutsLoop;
      for (const event of events) log(`${chain} ${event}`);
      return {
        payouts: p,
        refunds: r,
        heldWhenRefundsConfirmed,
        addresses: [payouts.address, refunds.address],
      };
    }
    if (
      Date.now() > deadline ||
      ['failed', 'partial'].includes(p.status) ||
      r.status === 'failed'
    ) {
      for (const event of events) log(`${chain} ${event}`);
      throw new Error(`not confirmed: payouts ${JSON.stringify(p)} refunds ${JSON.stringify(r)}`);
    }
    await sleep(2_000);
  }
}

describe.runIf(RUN)('two named Senders on one chain, live (ADR-0060)', () => {
  const saved = { ...process.env };

  it('Solana devnet: both Senders send in one run, and a held Sender does not delay the other', async () => {
    const connection = getDevnetConnection();
    const funder = await getFundedSenderKeypair();
    const refunds = Keypair.generate();
    await sendAndConfirm(
      connection,
      [
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: refunds.publicKey,
          lamports: 0.02 * LAMPORTS_PER_SOL,
        }),
      ],
      funder,
    );
    const signer = await startSolanaSigner([funder, refunds]);
    try {
      const engine = await engineFor(
        'solana',
        {
          SOLANA_RPC_URL: DEVNET_RPC_URL,
          SOLANA_KNOWN_TOKENS: '',
          SIGNER_URL: signer.url,
          SIGNER_AUTH_TOKEN: signer.token,
        },
        {
          default: 'payouts',
          senders: {
            payouts: { address: funder.publicKey.toBase58() },
            refunds: { address: refunds.publicKey.toBase58() },
          },
        },
      );
      const recipients: [string, string] = [
        Keypair.generate().publicKey.toBase58(),
        Keypair.generate().publicKey.toBase58(),
      ];
      const result = await sendThroughBoth(
        engine,
        'solana',
        (recipient) => ({ type: 'payment', recipient, asset: 'SOL', amount: '1000000' }),
        recipients,
      );

      expect(result.heldWhenRefundsConfirmed).toBe(true);
      expect(result.payouts.sender).toEqual({ name: 'payouts', address: result.addresses[0] });
      expect(result.refunds.sender).toEqual({ name: 'refunds', address: result.addresses[1] });
      for (const recipient of recipients) {
        expect(await connection.getBalance(new PublicKey(recipient), 'confirmed')).toBe(1_000_000);
      }
      const senders = await engine.get<{ senders: { name: string; default: boolean }[] }>(
        '/v1/senders',
      );
      expect(senders.senders.map((s) => [s.name, s.default])).toEqual([
        ['payouts', true],
        ['refunds', false],
      ]);
    } finally {
      await signer.close();
      process.env = { ...saved };
    }
  }, 300_000);

  it(
    'Base Sepolia: both Senders send in one run on their own nonces, and a held Sender does not delay the other',
    async () => {
      const release = await acquireDevSenderLock();
      const dev = getDevSenderAccount();
      const refundsKey = generatePrivateKey();
      const refunds = privateKeyToAccount(refundsKey);
      const chain: ViemChain = {
        id: BASE_SEPOLIA_CHAIN_ID,
        name: 'Base Sepolia',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [BASE_SEPOLIA_RPC_URL] } },
      };
      const client = createPublicClient({ chain, transport: http(BASE_SEPOLIA_RPC_URL) });
      const wallet = createWalletClient({
        account: privateKeyToAccount(`0x${dev.privateKeyHex}`),
        chain,
        transport: http(BASE_SEPOLIA_RPC_URL),
      });
      const signer = await startBaseSigner([
        dev,
        { address: refunds.address, privateKeyHex: refundsKey.slice(2) },
      ]);
      try {
        const funding = await wallet.sendTransaction({
          to: refunds.address,
          value: 50_000_000_000_000n,
        });
        await client.waitForTransactionReceipt({ hash: funding });
        const engine = await engineFor(
          'base',
          {
            BASE_RPC_URL: BASE_SEPOLIA_RPC_URL,
            BASE_CHAIN_ID: String(BASE_SEPOLIA_CHAIN_ID),
            BASE_KNOWN_TOKENS: '',
            BASE_TRACE_RPC_URL: '',
            SIGNER_URL: signer.url,
            SIGNER_AUTH_TOKEN: signer.token,
          },
          {
            default: 'payouts',
            senders: { payouts: { address: dev.address }, refunds: { address: refunds.address } },
          },
        );
        const recipients: [string, string] = [
          privateKeyToAccount(generatePrivateKey()).address,
          privateKeyToAccount(generatePrivateKey()).address,
        ];
        const result = await sendThroughBoth(
          engine,
          'base',
          (recipient) => ({ type: 'payment', recipient, asset: 'ETH', amount: '1000' }),
          recipients,
        );

        expect(result.heldWhenRefundsConfirmed).toBe(true);
        expect(result.payouts.sender?.name).toBe('payouts');
        expect(result.refunds.sender?.name).toBe('refunds');
        for (const recipient of recipients) {
          expect(await client.getBalance({ address: recipient as `0x${string}` })).toBe(1000n);
        }
        const transactionOf = (d: WireDispatch) =>
          client.getTransaction({ hash: d.items[0]?.transactionHash as `0x${string}` });
        const payoutsTx = await transactionOf(result.payouts);
        const refundsTx = await transactionOf(result.refunds);
        log(`base payouts nonce ${payoutsTx.nonce} from ${payoutsTx.from}`);
        log(`base refunds nonce ${refundsTx.nonce} from ${refundsTx.from}`);
        expect(refundsTx.nonce).toBe(0);
        expect(refundsTx.from.toLowerCase()).toBe(refunds.address.toLowerCase());
      } finally {
        await signer.close();
        await release();
        process.env = { ...saved };
      }
    },
    DEV_SENDER_LOCK_HOOK_TIMEOUT_MS + 300_000,
  );
});
