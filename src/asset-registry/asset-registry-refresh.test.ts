import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import pino from 'pino';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { BaseChainHandler } from '../chain-handler/base/base-chain-handler.js';
import type { ReadToken } from '../chain-handler/chain-handler.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { config } from '../config.js';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';
import { ok } from '../domain/result.js';
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';
import { PostgresDispatchStore } from '../repository/postgres-dispatch-store.js';
import { AssetRegistry } from './asset-registry.js';
import { KNOWN_ASSETS_CHANNEL, watchKnownAssets, type ListenForChanges } from './watch.js';

const SENDER = '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A';
const RECIPIENT = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const OPERATOR = 'refresh-test-operator';
const silent = pino({ level: 'silent' });

/** The JSON-RPC answers a Base handler needs: chain id, nonce, no Multicall3, and a balance of 1,000,000 for any token. */
const fakeBaseRpc: typeof fetch = (_input, init) => {
  const { id, method } = JSON.parse(init?.body as string) as { id: number; method: string };
  const results: Record<string, unknown> = {
    eth_chainId: '0x14a34',
    eth_getTransactionCount: '0x0',
    eth_getCode: '0x',
    eth_call: `0x${(1_000_000).toString(16).padStart(64, '0')}`,
  };
  return Promise.resolve(Response.json({ jsonrpc: '2.0', id, result: results[method] }));
};

/** A distinct token per test, so tests sharing the database never see each other's. */
function token() {
  const address = `0x${randomUUID().replace(/-/g, '').slice(0, 40).padStart(40, '0')}`;
  const symbol = `T${randomUUID().slice(0, 6).toUpperCase()}`;
  const read: ReadToken = (asked) =>
    Promise.resolve(
      ok({
        chain: 'base',
        kind: 'erc20',
        address: asked.length === 42 ? address : asked,
        symbol,
        name: 'Refresh Test Token',
        decimals: 6,
        supply: '1000000000',
      }),
    );
  return { address, symbol, read };
}

const listeners: postgres.Sql[] = [];
const stops: (() => Promise<void>)[] = [];

// A database of its own: the store tests truncate the shared one while they run.
const name = `dispatch_assets_${randomUUID().slice(0, 8)}`;
const databaseUrl = Object.assign(new URL(config.databaseUrl), { pathname: `/${name}` }).href;
const admin = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
let db: Database;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const client = postgres(databaseUrl, { onnotice: () => {} });
  listeners.push(client);
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: 'drizzle' });
}, 30_000);

/** One engine process's registry: its own database connection, listening as `loadAssetRegistry` does. */
async function processRegistry(listen: 'notify' | 'fails'): Promise<AssetRegistry> {
  const store = new PostgresDispatchStore(db);
  const registry = new AssetRegistry(() => store.listKnownAssets());
  await registry.refresh();
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  listeners.push(client);
  const subscribe: ListenForChanges =
    listen === 'notify'
      ? (onChange) => client.listen(KNOWN_ASSETS_CHANNEL, onChange, onChange)
      : () => Promise.reject(new Error('LISTEN is not available'));
  stops.push(await watchKnownAssets(registry, { listen: subscribe, pollMs: 50, logger: silent }));
  return registry;
}

async function baseHandler(registry: AssetRegistry) {
  return BaseChainHandler.create({
    rpcUrl: 'http://base.invalid',
    chainId: 84532,
    senderAddress: SENDER,
    assets: registry.forChain('base'),
    nonceHistoryStore: new InMemoryNonceHistoryStore(),
    fetch: fakeBaseRpc,
  });
}

async function apiProcess(read: ReadToken) {
  const assets = await processRegistry('notify');
  const app = buildApp({
    store: new PostgresDispatchStore(db),
    chainRegistry: await ChainRegistry.load(['base'], { base: () => baseHandler(assets) }),
    authToken: 'refresh-test-token',
    operatorToken: OPERATOR,
    defaultRetryPolicy: false,
    assets,
    readToken: { base: read },
    listSenders: () => Promise.resolve([]),
    readSetup: () => Promise.reject(new Error('not read in this test')),
  });
  await app.ready();
  const pay = (symbol: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { authorization: `Bearer ${OPERATOR}`, 'idempotency-key': randomUUID() },
      payload: {
        chain: 'base',
        items: [{ type: 'payment', recipient: RECIPIENT, asset: symbol, amount: '1500000' }],
      },
    });
  const add = (address: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: { authorization: `Bearer ${OPERATOR}` },
      payload: { chain: 'base', address },
    });
  return { pay, add };
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

afterAll(async () => {
  for (const stop of stops) await stop();
  for (const client of listeners) await client.end({ timeout: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

describe('an asset added from the console (ADR-0061)', () => {
  it('is payable on the API’s next request and readable by the worker, with no restart', async () => {
    const { address, symbol, read } = token();
    const api = await apiProcess(read);
    const worker = await baseHandler(await processRegistry('notify'));

    const before = await api.pay(symbol);
    expect(before.statusCode).toBe(400);
    expect(before.json()).toMatchObject({ code: 'UNKNOWN_ASSET' });
    expect(await worker.getBalance(SENDER, symbol)).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_ASSET' },
    });

    expect((await api.add(address)).statusCode).toBe(201);

    expect((await api.pay(symbol)).statusCode).toBe(202);
    const funded = () => worker.getBalance(SENDER, symbol).then((balance) => balance.ok);
    expect(await eventually(funded)).toBe(true);
    expect(await worker.getBalance(SENDER, symbol)).toEqual(
      ok({ asset: symbol, amount: '1000000' }),
    );
  });

  it('reaches a process that cannot listen, by its poll', async () => {
    const { address, symbol, read } = token();
    const api = await apiProcess(read);
    const worker = await baseHandler(await processRegistry('fails'));

    expect((await api.add(address)).statusCode).toBe(201);

    const funded = () => worker.getBalance(SENDER, symbol).then((balance) => balance.ok);
    expect(await eventually(funded)).toBe(true);
  });
});
