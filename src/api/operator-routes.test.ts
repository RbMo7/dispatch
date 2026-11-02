import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';

const CLIENT = { authorization: 'Bearer client-token' };
const OPERATOR = { authorization: 'Bearer operator-token' };

async function buildTestApp(operatorToken: string | null = 'operator-token') {
  let tick = 0;
  const store = new InMemoryDispatchStore(() => new Date(Date.UTC(2026, 9, 1) + tick++ * 1000));
  const app = buildApp({
    store,
    chainRegistry: await ChainRegistry.load(['base'], {
      base: () => Promise.resolve(new StubChainHandler()),
    }),
    authToken: 'client-token',
    ...(operatorToken === null ? {} : { operatorToken }),
    defaultRetryPolicy: false,
    assetDecimals: () => undefined,
    listSenders: () => Promise.resolve([]),
    readSetup: () => Promise.reject(new Error('not read in this test')),
  });
  return { app, store };
}

type App = Awaited<ReturnType<typeof buildTestApp>>['app'];

async function submit(app: App, key: string, headers = CLIENT): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/dispatch',
    headers: { ...headers, 'idempotency-key': key },
    payload: { chain: 'base', items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }] },
  });
  return response.json<{ dispatchId: string }>().dispatchId;
}

/** Every operator-only route. */
const SOME_ID = '00000000-0000-4000-8000-000000000000';
const OPERATOR_ONLY = [
  { method: 'GET', url: '/v1/activity' },
  { method: 'POST', url: '/v1/flag-rules' },
  { method: 'POST', url: '/v1/flag-rules/preview' },
  { method: 'PUT', url: `/v1/flag-rules/${SOME_ID}` },
  { method: 'DELETE', url: `/v1/flag-rules/${SOME_ID}` },
  { method: 'POST', url: `/v1/dispatch/${SOME_ID}/release` },
] as const;

describe('OPERATOR_TOKEN (ADR-0057)', () => {
  it('refuses to start when it equals AUTH_TOKEN, or is set but empty', async () => {
    await expect(buildTestApp('client-token')).rejects.toThrow(
      'OPERATOR_TOKEN must differ from AUTH_TOKEN',
    );
    await expect(buildTestApp('')).rejects.toThrow('OPERATOR_TOKEN is set but empty');
  });

  it('gives AUTH_TOKEN 403 on every operator-only route', async () => {
    const { app } = await buildTestApp();
    for (const route of OPERATOR_ONLY) {
      const response = await app.inject({ ...route, headers: CLIENT });
      expect(response.statusCode, route.url).toBe(403);
    }
  });

  it('answers 403 naming the missing token on operator-only routes when it is unset', async () => {
    const { app } = await buildTestApp(null);
    for (const route of OPERATOR_ONLY) {
      const response = await app.inject({ ...route, headers: CLIENT });
      expect(response.statusCode, route.url).toBe(403);
      expect(response.json<{ error: string }>().error).toContain(
        'OPERATOR_TOKEN is not configured',
      );
    }
  });

  it('answers 401 to an unknown token on operator-only routes', async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/activity',
      headers: { authorization: 'Bearer nope' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('works on every /v1 route AUTH_TOKEN can use', async () => {
    const { app } = await buildTestApp();
    const id = await submit(app, 'k1', OPERATOR);

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: `/v1/dispatch/${id}`, headers: OPERATOR }),
      app.inject({ method: 'GET', url: '/v1/dispatches', headers: OPERATOR }),
      app.inject({ method: 'GET', url: '/v1/senders', headers: OPERATOR }),
      app.inject({ method: 'POST', url: `/v1/dispatch/${id}/cancel`, headers: OPERATOR }),
    ]);

    expect(id).toEqual(expect.any(String));
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
  });
});

describe('GET /v1/token', () => {
  it('names the token a request carries, and refuses an unknown one', async () => {
    const { app } = await buildTestApp();
    const kindFor = async (authorization: string) => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/token',
        headers: { authorization },
      });
      return [response.statusCode, response.json<unknown>()];
    };

    expect(await kindFor(CLIENT.authorization)).toEqual([200, { kind: 'auth' }]);
    expect(await kindFor(OPERATOR.authorization)).toEqual([200, { kind: 'operator' }]);
    expect(await kindFor('Bearer someone-else')).toEqual([401, { error: 'unauthorized' }]);
  });
});

describe('GET /v1/activity (ADR-0057)', () => {
  type ActivityBody = {
    actions: { action: string; targetId: string; tokenKind: string; reason: string | null }[];
    nextCursor: string | null;
  };

  it('lists each cancel once, newest first, with the token kind and reason', async () => {
    const { app } = await buildTestApp();
    const first = await submit(app, 'k1');
    const second = await submit(app, 'k2');
    await app.inject({ method: 'POST', url: `/v1/dispatch/${first}/cancel`, headers: CLIENT });
    await app.inject({
      method: 'POST',
      url: `/v1/dispatch/${second}/cancel`,
      headers: OPERATOR,
      payload: { reason: 'duplicate run' },
    });
    await app.inject({ method: 'POST', url: `/v1/dispatch/${second}/cancel`, headers: OPERATOR });

    const response = await app.inject({ method: 'GET', url: '/v1/activity', headers: OPERATOR });

    expect(response.statusCode).toBe(200);
    expect(response.json<ActivityBody>()).toEqual({
      actions: [
        expect.objectContaining({
          action: 'cancel',
          targetId: second,
          tokenKind: 'operator',
          reason: 'duplicate run',
        }),
        expect.objectContaining({
          action: 'cancel',
          targetId: first,
          tokenKind: 'auth',
          reason: null,
        }),
      ],
      nextCursor: null,
    });
  });

  it('pages with nextCursor until it is null, never repeating an action', async () => {
    const { app } = await buildTestApp();
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = await submit(app, `k${i}`);
      await app.inject({ method: 'POST', url: `/v1/dispatch/${id}/cancel`, headers: CLIENT });
      ids.push(id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${cursor}` : '';
      const response = await app.inject({
        method: 'GET',
        url: `/v1/activity?limit=2${query}`,
        headers: OPERATOR,
      });
      const body = response.json<ActivityBody>();
      seen.push(...body.actions.map((a) => a.targetId));
      cursor = body.nextCursor;
    } while (cursor);

    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('refuses a cancel reason that is not a non-empty string', async () => {
    const { app } = await buildTestApp();
    const id = await submit(app, 'k1');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/dispatch/${id}/cancel`,
      headers: CLIENT,
      payload: { reason: '  ' },
    });

    expect(response.statusCode).toBe(400);
  });
});
