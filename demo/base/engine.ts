/**
 * Shared plumbing for the Base Sepolia demos (not part of the engine's own
 * test suite): deploy a demo contract outside the engine, boot a real
 * in-process dispatchxyz engine (API over real HTTP + Coordinator + a
 * Signer), and push a Managed Dispatch through `POST /v1/dispatch` until
 * `GET /v1/dispatch/:id` reports a terminal state.
 *
 * Every demo sends from the dev-sender in `signer/keys.dev.json`
 * — the same funded Base Sepolia wallet the live tests use. Don't run a
 * demo while `pnpm test` is running: both would own its nonce.
 */
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { createPublicClient, createWalletClient, http, type Abi, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { buildApp } from '../../src/app.js';
import type { BaseTokenRegistry } from '../../src/chain-handler/base/known-tokens.js';
import {
  BASE_ABANDONMENT_TIMEOUT_MS,
  BaseChainHandler,
} from '../../src/chain-handler/base/base-chain-handler.js';
import {
  compileContract,
  getDevSenderAccount,
  startTestSigner,
} from '../../src/chain-handler/base/test-support/base-fixtures.js';
import { ChainRegistry } from '../../src/chain-registry/chain-registry.js';
import { Coordinator } from '../../src/coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../../src/repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../../src/repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../src/signer/client.js';

if (existsSync('.env')) process.loadEnvFile('.env');

export const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const AUTH_TOKEN = 'demo-token';

const chain: Chain = {
  id: CHAIN_ID,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

export const sender = getDevSenderAccount();
export const client = createPublicClient({ chain, transport: http(RPC_URL) });

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Base Sepolia RPCs are multi-node gateways with no read-after-write
 * guarantee, so a read right after a confirm can be stale — poll it.
 */
export async function waitFor<T>(
  read: () => Promise<T>,
  expected: T,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value === expected || Date.now() > deadline) return value;
    await sleep(1_000);
  }
}

/** Compiles and deploys a contract from the dev-sender, directly — setup, not a dispatch. */
export async function deploy(
  name: string,
  source: string,
  args: unknown[] = [],
): Promise<{ address: `0x${string}`; abi: Abi }> {
  const { abi, bytecode } = compileContract(name, source);
  const account = privateKeyToAccount(`0x${sender.privateKeyHex}`);
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deploy (${hash}) reported no address`);

  // The engine reads the Sender's next nonce at startup; don't let a lagging
  // node hand it the deploy's nonce again.
  const { nonce } = await client.getTransaction({ hash });
  await waitFor(
    async () => (await client.getTransactionCount({ address: sender.address })) > nonce,
    true,
  );
  console.log(`Deployed ${name} at ${receipt.contractAddress} (tx ${hash})`);
  return { address: receipt.contractAddress, abi };
}

type DispatchBody = {
  dispatchId: string;
  status: string;
  items: { status: string; transactionHash: string | null; error: unknown }[];
};

/**
 * Boots the engine for 'base' the way index.ts + worker.ts do, minus
 * Postgres (in-memory store, one process), and returns a function that
 * submits a Managed Dispatch over real HTTP and drives it to a terminal state.
 */
export async function startEngine(knownTokens: BaseTokenRegistry = {}) {
  const signer = await startTestSigner([sender]);
  const store = new InMemoryDispatchStore();
  const chainRegistry = await ChainRegistry.load(['base'], {
    base: () =>
      BaseChainHandler.create({
        rpcUrl: RPC_URL,
        chainId: CHAIN_ID,
        senderAddress: sender.address,
        signerClient: new SignerClient(signer.url, signer.token),
        nonceHistoryStore: new InMemoryNonceHistoryStore(),
        knownTokens,
      }),
  });
  const app = buildApp({ store, chainRegistry, authToken: AUTH_TOKEN, defaultRetryPolicy: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  console.log(`Engine API listening on ${baseUrl}`);

  // The worker's job (worker.ts), run in-process here.
  const coordinator = new Coordinator({
    store,
    chainHandlers: chainRegistry.handlers,
    senderAddresses: new Map([['base', sender.address]]),
    abandonmentTimeoutMs: new Map([['base', BASE_ABANDONMENT_TIMEOUT_MS]]),
  });

  async function dispatch(items: unknown[], timeoutMs = 180_000): Promise<DispatchBody> {
    const headers = { authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/json' };
    const post = await fetch(`${baseUrl}/v1/dispatch`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': `base-demo-${Date.now()}` },
      body: JSON.stringify({ chain: 'base', items }),
    });
    const accepted = (await post.json()) as { dispatchId: string; status: string };
    console.log('POST /v1/dispatch ->', post.status, accepted);
    if (post.status !== 202) throw new Error('engine rejected the dispatch');

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await coordinator.processQueuedDispatches(20);
      await coordinator.pollPendingTransactions(20);
      const get = await fetch(`${baseUrl}/v1/dispatch/${accepted.dispatchId}`, { headers });
      const body = (await get.json()) as DispatchBody;
      if (['confirmed', 'failed', 'partial'].includes(body.status)) {
        console.log('GET /v1/dispatch/:id ->', JSON.stringify(body, null, 2));
        return body;
      }
      if (Date.now() > deadline)
        throw new Error(`dispatch still ${body.status} after ${timeoutMs}ms`);
      await sleep(2_000);
    }
  }

  async function close(): Promise<void> {
    await app.close();
    await signer.close();
  }

  return { dispatch, close };
}

/** Runs a demo, failing the process loudly on any error. */
export function run(demo: () => Promise<void>): void {
  demo().then(
    () => process.exit(0),
    (cause: unknown) => {
      console.error(cause);
      process.exit(1);
    },
  );
}
