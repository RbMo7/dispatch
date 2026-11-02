import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { AssetRegistry } from '../asset-registry/asset-registry.js';
import { configuredAssets } from '../asset-registry/configured-assets.js';
import { BaseChainHandler } from '../chain-handler/base/base-chain-handler.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { CHAINS } from '../domain/chain.js';
import { readRecorded, recorded, VAULT } from '../effects/test-support/recorded.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';

const API = 'api-token';
const OPERATOR = 'operator-token';

/** FlowVault's ABI as `solc` writes it, pasted as text. */
const FLOW_VAULT_ABI = JSON.stringify([
  {
    type: 'event',
    name: 'Deposited',
    anonymous: false,
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'note', type: 'string', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [{ name: 'note', type: 'string' }],
    outputs: [],
  },
]);

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
  await store.seedConfigAssets(configuredAssets({ solana: '', base: '' }));
  const assets = new AssetRegistry(() => store.listKnownAssets());
  await assets.refresh();
  const app = buildApp({
    store,
    chainRegistry: await ChainRegistry.load(['base'], {
      base: () =>
        BaseChainHandler.create({
          rpcUrl: 'http://base.invalid',
          chainId: 84532,
          senderAddress: '0x8cdBF57d39066712E9eDADb0822D7b89E7699e06',
          assets: assets.forChain('base'),
          nonceHistoryStore: new InMemoryNonceHistoryStore(),
          fetch: fakeBaseRpc,
        }),
    }),
    authToken: API,
    operatorToken: OPERATOR,
    defaultRetryPolicy: false,
    assets,
    readToken: {},
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
  return { store, call };
}

/** Row 4 of the flows, recorded: FlowVault.deposit("flows row 4") with 0.000001 ETH, confirmed and read by the worker. */
async function confirmedVaultDeposit(store: InMemoryDispatchStore): Promise<string> {
  const { hash, rpc } = recorded('base-call-with-value');
  const sent = rpc.eth_getTransactionByHash as { to: string; input: string; value: string };
  const dispatch = await store.createDispatch({
    chain: 'base',
    idempotencyKey: 'vault-deposit',
    items: [
      {
        call: { to: sent.to, data: sent.input, value: BigInt(sent.value).toString() },
        payment: null,
      },
    ],
    retryPolicy: false,
  });
  await store.claimQueued(CHAINS, 10);
  const [row] = await store.createTransactions([
    { dispatchId: dispatch.id, callIndex: 0, chain: 'base', signedBytes: 'signed', hash },
  ]);
  await store.markConfirmed(row!.id);
  await store.recordEffects(
    { chain: 'base', hash },
    await readRecorded('base-call-with-value'),
    new Date(),
  );
  return dispatch.id;
}

type ItemView = {
  call: { decoded: boolean; label?: string; function?: string; args?: unknown[] };
  effects: { events: { name: string; label?: string }[]; undecodedEvents: number };
};

describe('contract registry routes (ADR-0063)', () => {
  it('explains a call that confirmed before its ABI was registered, and its event', async () => {
    const { store, call } = await engine();
    const id = await confirmedVaultDeposit(store);
    const item = async () =>
      (await call('GET', `/v1/dispatch/${id}`, undefined, API)).json<{ items: ItemView[] }>()
        .items[0]!;

    const before = await item();
    expect(before.call.decoded).toBe(false);
    expect(before.effects.undecodedEvents).toBe(1);

    const added = await call('POST', '/v1/contracts', {
      chain: 'base',
      address: VAULT.toLowerCase(),
      label: 'FlowVault',
      abi: FLOW_VAULT_ABI,
      reason: 'explain vault deposits',
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      address: VAULT,
      label: 'FlowVault',
      functions: ['deposit(string note)'],
      events: ['Deposited(address indexed from, uint256 amount, string note)'],
      enabled: true,
      addedBy: 'operator',
    });

    const after = await item();
    expect(after.call).toMatchObject({
      decoded: true,
      label: 'FlowVault',
      function: 'deposit',
      args: [{ name: 'note', type: 'string', value: 'flows row 4' }],
    });
    expect(after.effects.events).toMatchObject([{ name: 'Deposited', label: 'FlowVault' }]);
    expect(after.effects.undecodedEvents).toBe(0);

    const contract = added.json<{ id: string }>();
    const disabled = await call('PATCH', `/v1/contracts/${contract.id}`, { enabled: false });
    expect(disabled.json()).toMatchObject({ enabled: false });
    expect((await item()).call.decoded).toBe(false);

    const actions = (await call('GET', '/v1/activity')).json<{
      actions: { action: string; targetId: string; reason: string | null }[];
    }>().actions;
    expect(actions.map((a) => [a.action, a.targetId, a.reason])).toEqual([
      ['contract_disable', contract.id, null],
      ['contract_add', contract.id, 'explain vault deposits'],
    ]);
  });

  it('lists with either token, and only the operator token registers', async () => {
    const { call } = await engine();
    const body = { chain: 'base', address: VAULT, label: 'FlowVault', abi: FLOW_VAULT_ABI };
    expect((await call('POST', '/v1/contracts', body, API)).statusCode).toBe(403);
    expect((await call('POST', '/v1/contracts/preview', body, API)).statusCode).toBe(403);
    expect((await call('POST', '/v1/contracts', body)).statusCode).toBe(201);

    const listed = await call('GET', '/v1/contracts?chain=base', undefined, API);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ contracts: { label: string }[] }>().contracts.map((c) => c.label)).toEqual(
      ['FlowVault'],
    );
  });

  it('previews what an ABI explains without storing it', async () => {
    const { call } = await engine();
    const preview = await call('POST', '/v1/contracts/preview', {
      chain: 'base',
      address: VAULT,
      label: 'FlowVault',
      abi: JSON.parse(FLOW_VAULT_ABI) as unknown,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      chain: 'base',
      address: VAULT,
      label: 'FlowVault',
      functions: ['deposit(string note)'],
      events: ['Deposited(address indexed from, uint256 amount, string note)'],
    });
    expect((await call('GET', '/v1/contracts')).json()).toEqual({ contracts: [] });
  });

  it.each([
    [
      { abi: '[{"type":"function","name":"pay","inputs":[{"name":"to","type":"adress"}]}]' },
      'INVALID_ABI',
      'abi[0].inputs[0].type: "adress" is not a Solidity type',
    ],
    [{ abi: '[{"type":"function",' }, 'INVALID_ABI', 'abi: is not JSON'],
  ])(
    'refuses a malformed ABI with a 400 naming what is wrong: %j',
    async (definition, code, message) => {
      const { call } = await engine();
      const refused = await call('POST', '/v1/contracts', {
        chain: 'base',
        address: VAULT,
        label: 'FlowVault',
        ...definition,
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json<{ code: string; message: string }>()).toMatchObject({ code });
      expect(refused.json<{ message: string }>().message).toContain(message);
    },
  );

  it.each([
    [
      { chain: 'solana', address: VAULT, label: 'x', idl: {} },
      'chain: solana is not enabled on this engine',
    ],
    [
      { chain: 'base', address: 'vault', label: 'x', abi: '[]' },
      'address: vault is not a Base address',
    ],
    [
      { chain: 'base', address: VAULT, label: ' ', abi: '[]' },
      'label: required, what to call the contract',
    ],
    [{ chain: 'base', address: VAULT, label: 'x', idl: {} }, 'idl: Base takes an ABI in abi'],
  ])('refuses a request that is not a registration: %j', async (body, error) => {
    const { call } = await engine();
    const refused = await call('POST', '/v1/contracts', body);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error });
  });

  it('refuses a second registration at an address until the first is disabled', async () => {
    const { call } = await engine();
    const body = { chain: 'base', address: VAULT, label: 'FlowVault', abi: FLOW_VAULT_ABI };
    const first = (await call('POST', '/v1/contracts', body)).json<{ id: string }>();
    const again = await call('POST', '/v1/contracts', { ...body, label: 'Vault v2' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'CONTRACT_EXISTS' });

    await call('PATCH', `/v1/contracts/${first.id}`, { enabled: false });
    expect((await call('POST', '/v1/contracts', { ...body, label: 'Vault v2' })).statusCode).toBe(
      201,
    );
    const enable = await call('PATCH', `/v1/contracts/${first.id}`, { enabled: true });
    expect(enable.statusCode).toBe(409);
    expect(enable.json()).toMatchObject({ code: 'CONTRACT_EXISTS' });
  });
});
