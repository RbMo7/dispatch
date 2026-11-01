import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';

const CLIENT = { authorization: 'Bearer client-token' };
const OPERATOR = { authorization: 'Bearer operator-token' };
const BASE_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const SOLANA_ADDRESS = '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe';

async function buildTestApp() {
  return buildApp({
    store: new InMemoryDispatchStore(),
    chainRegistry: await ChainRegistry.load([], {}),
    authToken: 'client-token',
    operatorToken: 'operator-token',
    defaultRetryPolicy: false,
    assetDecimals: (chain, asset) =>
      ({ base: { USDC: 6, ETH: 18 }, solana: { SOL: 9 } })[chain][asset as never],
    listSenders: () => Promise.resolve([]),
    readSetup: () => Promise.reject(new Error('not read in this test')),
  });
}

type App = Awaited<ReturnType<typeof buildTestApp>>;
type RuleBody = { ruleId: string; version: number; versions: { version: number }[] } & Record<
  string,
  unknown
>;

const create = (app: App, payload: object, headers = OPERATOR) =>
  app.inject({ method: 'POST', url: '/v1/flag-rules', headers, payload });

const itemOver = { name: 'Item', chain: 'base', kind: 'item_over', asset: 'USDC', limit: '5000' };

const EACH_KIND = [
  itemOver,
  { name: 'Total', chain: 'base', kind: 'dispatch_total_over', asset: 'ETH', limit: '1.5' },
  { name: 'Daily', chain: 'solana', kind: 'daily_volume_over', asset: 'SOL', limit: '100' },
  { name: 'New payee', chain: 'solana', kind: 'first_time_recipient' },
  {
    name: 'Payees',
    chain: 'base',
    kind: 'recipient_not_allowlisted',
    addresses: [BASE_ADDRESS.toLowerCase()],
  },
  {
    name: 'Programs',
    chain: 'solana',
    kind: 'call_target_not_allowlisted',
    addresses: [SOLANA_ADDRESS],
  },
];

describe('/v1/flag-rules (ADR-0058)', () => {
  it('creates one rule of each kind as version 1, enabled unless told otherwise', async () => {
    const app = await buildTestApp();

    for (const rule of EACH_KIND) {
      const response = await create(app, rule);
      expect(response.statusCode, rule.kind).toBe(201);
      const expected =
        rule.kind === 'recipient_not_allowlisted' ? { ...rule, addresses: [BASE_ADDRESS] } : rule;
      expect(response.json(), rule.kind).toMatchObject({ ...expected, version: 1, enabled: true });
    }

    const list = await app.inject({ method: 'GET', url: '/v1/flag-rules', headers: CLIENT });
    expect(list.json<{ rules: unknown[] }>().rules).toHaveLength(EACH_KIND.length);
  });

  it.each([
    [{ chain: 'base', kind: 'first_time_recipient' }, 'name:'],
    [{ name: 'x', chain: 'tron', kind: 'first_time_recipient' }, 'chain:'],
    [{ name: 'x', chain: 'base', kind: 'amount_over' }, 'kind:'],
    [{ name: 'x', chain: 'base', kind: 'first_time_recipient', enabled: 'yes' }, 'enabled:'],
    [{ name: 'x', chain: 'base', kind: 'item_over', asset: 'DOGE', limit: '1' }, 'asset:'],
    [{ name: 'x', chain: 'base', kind: 'item_over', asset: 'USDC', limit: 5 }, 'limit:'],
    [{ name: 'x', chain: 'base', kind: 'item_over', asset: 'USDC', limit: '0' }, 'limit:'],
    [{ name: 'x', chain: 'base', kind: 'item_over', asset: 'USDC', limit: '-1' }, 'limit:'],
    [{ name: 'x', chain: 'base', kind: 'item_over', asset: 'USDC', limit: '1.0000001' }, 'limit:'],
    [{ name: 'x', chain: 'base', kind: 'first_time_recipient', asset: 'USDC' }, 'asset:'],
    [
      { name: 'x', chain: 'base', kind: 'recipient_not_allowlisted', addresses: ['0x12'] },
      'addresses[0]:',
    ],
    [
      { name: 'x', chain: 'solana', kind: 'recipient_not_allowlisted', addresses: [BASE_ADDRESS] },
      'addresses[0]:',
    ],
    [{ name: 'x', chain: 'base', kind: 'first_time_recipient', reason: '' }, 'reason:'],
  ])('refuses %j with a 400 naming the field', async (payload, field) => {
    const app = await buildTestApp();

    const response = await create(app, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toMatch(
      new RegExp(`^${field.replace(/[[\]]/g, '\\$&')}`),
    );
  });

  it('accepts a limit at the asset precision', async () => {
    const app = await buildTestApp();

    const response = await create(app, {
      name: 'x',
      chain: 'base',
      kind: 'item_over',
      asset: 'USDC',
      limit: '0.000001',
    });

    expect(response.statusCode).toBe(201);
  });

  it('an edit increments the version, and the previous one stays readable', async () => {
    const app = await buildTestApp();
    const { ruleId } = (await create(app, itemOver)).json<RuleBody>();

    const edited = await app.inject({
      method: 'PUT',
      url: `/v1/flag-rules/${ruleId}`,
      headers: OPERATOR,
      payload: { ...itemOver, limit: '7500', reason: 'payroll grew' },
    });

    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      ruleId,
      version: 2,
      limit: '7500',
      versions: [
        { version: 1, limit: '5000' },
        { version: 2, limit: '7500' },
      ],
    });
    const read = await app.inject({
      method: 'GET',
      url: `/v1/flag-rules/${ruleId}`,
      headers: CLIENT,
    });
    expect(read.json()).toEqual(edited.json());
  });

  it('a delete hides the rule from the list, keeps its history, and refuses later edits', async () => {
    const app = await buildTestApp();
    const { ruleId } = (await create(app, itemOver)).json<RuleBody>();

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/flag-rules/${ruleId}`,
      headers: OPERATOR,
    });
    const edit = await app.inject({
      method: 'PUT',
      url: `/v1/flag-rules/${ruleId}`,
      headers: OPERATOR,
      payload: itemOver,
    });
    const list = await app.inject({ method: 'GET', url: '/v1/flag-rules', headers: OPERATOR });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ deletedAt: expect.any(String) as string });
    expect(edit.statusCode).toBe(409);
    expect(list.json()).toEqual({ rules: [] });
  });

  it('gives AUTH_TOKEN 403 on every write but lets it read', async () => {
    const app = await buildTestApp();
    const { ruleId } = (await create(app, itemOver)).json<RuleBody>();

    const writes = await Promise.all([
      create(app, itemOver, CLIENT),
      app.inject({
        method: 'PUT',
        url: `/v1/flag-rules/${ruleId}`,
        headers: CLIENT,
        payload: itemOver,
      }),
      app.inject({ method: 'DELETE', url: `/v1/flag-rules/${ruleId}`, headers: CLIENT }),
    ]);
    const reads = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/flag-rules', headers: CLIENT }),
      app.inject({ method: 'GET', url: `/v1/flag-rules/${ruleId}`, headers: CLIENT }),
    ]);

    expect(writes.map((r) => r.statusCode)).toEqual([403, 403, 403]);
    expect(reads.map((r) => r.statusCode)).toEqual([200, 200]);
  });

  it('records each write in the activity record', async () => {
    const app = await buildTestApp();
    const { ruleId } = (await create(app, { ...itemOver, reason: 'launch' })).json<RuleBody>();
    await app.inject({ method: 'DELETE', url: `/v1/flag-rules/${ruleId}`, headers: OPERATOR });

    const activity = await app.inject({ method: 'GET', url: '/v1/activity', headers: OPERATOR });

    expect(
      activity
        .json<{ actions: { action: string; targetId: string; reason: string | null }[] }>()
        .actions.map(({ action, targetId, reason }) => ({ action, targetId, reason }))
        .sort((a, b) => a.action.localeCompare(b.action)),
    ).toEqual([
      { action: 'flag_rule_create', targetId: ruleId, reason: 'launch' },
      { action: 'flag_rule_delete', targetId: ruleId, reason: null },
    ]);
  });
});
