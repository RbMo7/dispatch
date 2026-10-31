import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import { CHAINS } from '../domain/chain.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';

const CLIENT = { authorization: 'Bearer client-token' };
const OPERATOR = { authorization: 'Bearer operator-token' };
const ALICE = '0x52908400098527886E0F7030069857D2E4169EE7';
const BOB = '0x8617E340B3D01FA5F11F306F4090FD50E238070D';

async function buildTestApp() {
  const store = new InMemoryDispatchStore();
  const app = buildApp({
    store,
    chainRegistry: await ChainRegistry.load(['base', 'solana'], {
      base: () => Promise.resolve(new StubChainHandler()),
      solana: () => Promise.resolve(new StubChainHandler()),
    }),
    authToken: 'client-token',
    operatorToken: 'operator-token',
    defaultRetryPolicy: false,
    assetDecimals: (chain, asset) =>
      ({ base: { USDC: 6, ETH: 18 }, solana: { SOL: 9 } })[chain][asset as never],
    listSenders: () => Promise.resolve([]),
  });
  return { app, store };
}

type App = Awaited<ReturnType<typeof buildTestApp>>['app'];

async function addRule(app: App, rule: object): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/flag-rules',
    headers: OPERATOR,
    payload: rule,
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ ruleId: string }>().ruleId;
}

const payment = (amount: string, recipient = ALICE) => ({
  type: 'payment',
  recipient,
  asset: 'USDC',
  amount,
});

async function submit(app: App, key: string, payload: object) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/dispatch',
    headers: { ...CLIENT, 'idempotency-key': key },
    payload,
  });
  return {
    statusCode: response.statusCode,
    ...response.json<{ dispatchId: string; status: string }>(),
  };
}

const read = async (app: App, id: string) =>
  (await app.inject({ method: 'GET', url: `/v1/dispatch/${id}`, headers: CLIENT })).json<{
    status: string;
    items: { status: string }[];
    hold?: unknown;
  }>();

const bigUsdc = {
  name: 'Big USDC',
  chain: 'base',
  kind: 'item_over',
  asset: 'USDC',
  limit: '5000',
};
const knownPayees = {
  name: 'Known payees',
  chain: 'base',
  kind: 'recipient_not_allowlisted',
  addresses: [ALICE],
};

describe('POST /v1/dispatch against Flag Rules (ADR-0058)', () => {
  it('holds the whole Dispatch on a match, naming every matching rule and item', async () => {
    const { app, store } = await buildTestApp();
    const bigId = await addRule(app, bigUsdc);
    const payeesId = await addRule(app, knownPayees);

    const posted = await submit(app, 'k1', {
      chain: 'base',
      items: [payment('1'), payment('5000000001'), payment('2', BOB), payment('6000000000', BOB)],
    });

    expect(posted).toMatchObject({ statusCode: 202, status: 'held' });
    expect(await read(app, posted.dispatchId)).toMatchObject({
      status: 'held',
      items: [{ status: 'held' }, { status: 'held' }, { status: 'held' }, { status: 'held' }],
      hold: {
        matched: [
          {
            rule: { name: 'Big USDC', kind: 'item_over', asset: 'USDC', limit: '5000' },
            ruleId: bigId,
            ruleVersion: 1,
            items: [1, 3],
          },
          {
            rule: { name: 'Known payees', kind: 'recipient_not_allowlisted', addresses: [ALICE] },
            ruleId: payeesId,
            ruleVersion: 1,
            items: [2, 3],
          },
        ],
        heldAt: expect.any(String) as string,
      },
    });
    expect(await store.claimQueued(CHAINS, 10)).toEqual([]);
  });

  it('queues a Dispatch that matches nothing, with no hold block', async () => {
    const { app } = await buildTestApp();
    await addRule(app, bigUsdc);

    const posted = await submit(app, 'k1', { chain: 'base', items: [payment('5000000000')] });

    expect(posted.status).toBe('queued');
    expect(await read(app, posted.dispatchId)).not.toHaveProperty('hold');
  });

  it('never checks a chain with no rules, nor a disabled rule', async () => {
    const { app } = await buildTestApp();
    await addRule(app, { ...bigUsdc, chain: 'solana', asset: 'SOL' });
    await addRule(app, { ...bigUsdc, enabled: false });

    const posted = await submit(app, 'k1', { chain: 'base', items: [payment('9000000000')] });

    expect(posted.status).toBe('queued');
  });

  it('never checks a Relay Dispatch', async () => {
    const { app } = await buildTestApp();
    await addRule(app, {
      name: 'All calls',
      chain: 'base',
      kind: 'call_target_not_allowlisted',
      addresses: [],
    });

    const posted = await submit(app, 'k1', {
      chain: 'base',
      mode: 'relay',
      signedTransaction: '0xsigned',
    });

    expect(posted.status).toBe('queued');
  });

  it('holds on a call target off the allowlist', async () => {
    const { app } = await buildTestApp();
    await addRule(app, {
      name: 'Contracts',
      chain: 'base',
      kind: 'call_target_not_allowlisted',
      addresses: [ALICE],
    });

    const posted = await submit(app, 'k1', {
      chain: 'base',
      items: [
        { type: 'call', to: ALICE.toLowerCase(), data: '0x', value: '0' },
        { type: 'call', to: BOB, data: '0x', value: '0' },
      ],
    });

    expect(posted.status).toBe('held');
    expect(await read(app, posted.dispatchId)).toMatchObject({
      hold: { matched: [{ items: [1] }] },
    });
  });

  it('counts the last 24 hours of accepted Dispatches toward a daily volume', async () => {
    const { app } = await buildTestApp();
    await addRule(app, {
      name: 'Daily',
      chain: 'base',
      kind: 'daily_volume_over',
      asset: 'USDC',
      limit: '10',
    });

    const first = await submit(app, 'k1', { chain: 'base', items: [payment('6000000')] });
    const second = await submit(app, 'k2', { chain: 'base', items: [payment('4000000')] });
    const third = await submit(app, 'k3', { chain: 'base', items: [payment('1')] });

    expect([first.status, second.status, third.status]).toEqual(['queued', 'queued', 'held']);
  });

  it('holds a payment to a recipient never paid before', async () => {
    const { app } = await buildTestApp();
    await addRule(app, { name: 'New payee', chain: 'base', kind: 'first_time_recipient' });

    const posted = await submit(app, 'k1', { chain: 'base', items: [payment('1')] });

    expect(posted.status).toBe('held');
  });

  it('answers a resubmitted Idempotency-Key with the stored Dispatch, never re-checking it', async () => {
    const { app } = await buildTestApp();
    const ruleId = await addRule(app, bigUsdc);
    const held = await submit(app, 'k1', { chain: 'base', items: [payment('9000000000')] });
    const queued = await submit(app, 'k2', { chain: 'base', items: [payment('1')] });

    await app.inject({ method: 'DELETE', url: `/v1/flag-rules/${ruleId}`, headers: OPERATOR });
    await addRule(app, { ...bigUsdc, limit: '0.000001' });

    expect(
      await submit(app, 'k1', { chain: 'base', items: [payment('9000000000')] }),
    ).toMatchObject({
      dispatchId: held.dispatchId,
      status: 'held',
    });
    expect(await submit(app, 'k2', { chain: 'base', items: [payment('1')] })).toMatchObject({
      dispatchId: queued.dispatchId,
      status: 'queued',
    });
  });

  it('keeps the matched version on a held Dispatch after the rule is edited', async () => {
    const { app } = await buildTestApp();
    const ruleId = await addRule(app, bigUsdc);
    const held = await submit(app, 'k1', { chain: 'base', items: [payment('9000000000')] });

    await app.inject({
      method: 'PUT',
      url: `/v1/flag-rules/${ruleId}`,
      headers: OPERATOR,
      payload: { ...bigUsdc, limit: '100000' },
    });

    expect(await read(app, held.dispatchId)).toMatchObject({
      status: 'held',
      hold: { matched: [{ ruleVersion: 1, rule: { limit: '5000' } }] },
    });
  });

  it('lists held Dispatches under status=held', async () => {
    const { app } = await buildTestApp();
    await addRule(app, bigUsdc);
    const held = await submit(app, 'k1', { chain: 'base', items: [payment('9000000000')] });
    await submit(app, 'k2', { chain: 'base', items: [payment('1')] });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/dispatches?status=held',
      headers: CLIENT,
    });

    expect(
      response.json<{ dispatches: { dispatchId: string; status: string }[] }>().dispatches,
    ).toEqual([expect.objectContaining({ dispatchId: held.dispatchId, status: 'held' })]);
  });
});
