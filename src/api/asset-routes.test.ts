import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { AssetRegistry } from '../asset-registry/asset-registry.js';
import { configuredAssets } from '../asset-registry/configured-assets.js';
import { BaseChainHandler } from '../chain-handler/base/base-chain-handler.js';
import type { ReadToken, TokenRead } from '../chain-handler/chain-handler.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { err, ok } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';

const API = 'api-token';
const OPERATOR = 'operator-token';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const EURC = '0x808456652fdb597867f38412077A9182bf77359F';
const WALLET = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';

const onChain: Record<string, TokenRead<'base'>> = {
  [EURC]: {
    chain: 'base',
    kind: 'erc20',
    address: EURC,
    symbol: 'EURC',
    name: 'EURC',
    decimals: 6,
    supply: '1000000',
  },
  // A token whose own symbol is one the engine already pays in.
  '0x00000000000000000000000000000000000000C1': {
    chain: 'base',
    kind: 'erc20',
    address: '0x00000000000000000000000000000000000000C1',
    symbol: 'USDC',
    name: 'Look-alike',
    decimals: 6,
    supply: '1',
  },
};

const readBase: ReadToken = (address) =>
  Promise.resolve(
    onChain[address]
      ? ok(onChain[address])
      : err({ code: 'NOT_A_TOKEN', message: `${address} has no contract code on this chain` }),
  );

const fakeBaseRpc: typeof fetch = (_input, init) => {
  const { id, method } = JSON.parse(init?.body as string) as { id: number; method: string };
  const results: Record<string, unknown> = {
    eth_chainId: '0x14a34',
    eth_getTransactionCount: '0x0',
    eth_getCode: '0x',
  };
  return Promise.resolve(Response.json({ jsonrpc: '2.0', id, result: results[method] }));
};

async function engine() {
  const store = new InMemoryDispatchStore();
  await store.seedConfigAssets(configuredAssets({ solana: '', base: `USDC:${USDC}:6` }));
  const assets = new AssetRegistry(() => store.listKnownAssets());
  await assets.refresh();
  const app = buildApp({
    store,
    chainRegistry: await ChainRegistry.load(['base'], {
      base: () =>
        BaseChainHandler.create({
          rpcUrl: 'http://base.invalid',
          chainId: 84532,
          senderAddress: '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A',
          assets: assets.forChain('base'),
          nonceHistoryStore: new InMemoryNonceHistoryStore(),
          fetch: fakeBaseRpc,
        }),
    }),
    authToken: API,
    operatorToken: OPERATOR,
    defaultRetryPolicy: false,
    assets,
    readToken: { base: readBase },
    listSenders: () => Promise.resolve([]),
    readSetup: () => Promise.reject(new Error('not read in this test')),
  });
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
    token = OPERATOR,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  const pay = (asset: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { authorization: `Bearer ${API}`, 'idempotency-key': randomUUID() },
      payload: {
        chain: 'base',
        items: [{ type: 'payment', recipient: WALLET, asset, amount: '1' }],
      },
    });
  return { store, call, pay };
}

describe('Known Asset routes (ADR-0061)', () => {
  it('lists the configured assets with either token, native first', async () => {
    const { call } = await engine();
    const listed = await call('GET', '/v1/assets?chain=base', undefined, API);
    expect(listed.statusCode).toBe(200);
    expect(
      listed
        .json<{ assets: { symbol: string; source: string }[] }>()
        .assets.map((a) => [a.symbol, a.source]),
    ).toEqual([
      ['ETH', 'config'],
      ['USDC', 'config'],
    ]);
  });

  it('previews and adds a token read from the chain, which a payment can then name', async () => {
    const { call, pay } = await engine();
    expect((await pay('EURC')).json()).toMatchObject({ code: 'UNKNOWN_ASSET' });

    const preview = await call('POST', '/v1/assets/preview', { chain: 'base', address: EURC });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ symbol: 'EURC', decimals: 6, supply: '1000000' });

    const added = await call('POST', '/v1/assets', { chain: 'base', address: EURC });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ symbol: 'EURC', source: 'console', enabled: true });
    expect((await pay('EURC')).statusCode).toBe(202);

    const activity = await call('GET', '/v1/activity');
    expect(activity.json()).toMatchObject({
      actions: [{ action: 'asset_add', targetId: added.json<{ id: string }>().id }],
    });
  });

  it('refuses an address that is not a token', async () => {
    const { call } = await engine();
    const refused = await call('POST', '/v1/assets', { chain: 'base', address: WALLET });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'NOT_A_TOKEN' });
  });

  it('refuses a symbol already used on the chain, unless the request gives another', async () => {
    const { call } = await engine();
    const address = '0x00000000000000000000000000000000000000C1';
    const clash = await call('POST', '/v1/assets', { chain: 'base', address });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ code: 'SYMBOL_TAKEN' });
    const ethClash = await call('POST', '/v1/assets', { chain: 'base', address, symbol: 'eth' });
    expect(ethClash.json()).toMatchObject({ code: 'SYMBOL_TAKEN' });

    const renamed = await call('POST', '/v1/assets', { chain: 'base', address, symbol: 'USDC.LK' });
    expect(renamed.statusCode).toBe(201);
    expect(renamed.json()).toMatchObject({ symbol: 'USDC.LK', name: 'Look-alike' });
  });

  it('refuses an address already known', async () => {
    const { call } = await engine();
    const known = await call('POST', '/v1/assets', { chain: 'base', address: USDC });
    expect(known.statusCode).toBe(409);
  });

  it('disables and enables a console asset, and a disabled one is not payable', async () => {
    const { call, pay } = await engine();
    const { id } = (await call('POST', '/v1/assets', { chain: 'base', address: EURC })).json<{
      id: string;
    }>();
    const off = await call('PATCH', `/v1/assets/${id}`, { enabled: false, reason: 'paused' });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false });
    expect((await pay('EURC')).json()).toMatchObject({ code: 'UNKNOWN_ASSET' });

    expect((await call('PATCH', `/v1/assets/${id}`, { enabled: true })).statusCode).toBe(200);
    expect((await pay('EURC')).statusCode).toBe(202);
  });

  it('refuses to change a config asset, and answers 404 for an unknown id', async () => {
    const { call } = await engine();
    const { assets } = (await call('GET', '/v1/assets')).json<{
      assets: { id: string; symbol: string }[];
    }>();
    const usdc = assets.find((a) => a.symbol === 'USDC')!;
    const refused = await call('PATCH', `/v1/assets/${usdc.id}`, { enabled: false });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'CONFIG_ASSET' });
    const missing = await call('PATCH', `/v1/assets/${randomUUID()}`, { enabled: false });
    expect(missing.statusCode).toBe(404);
  });

  it('keeps writes for the operator token', async () => {
    const { call } = await engine();
    const refused = await call('POST', '/v1/assets', { chain: 'base', address: EURC }, API);
    expect(refused.statusCode).toBe(403);
  });
});
