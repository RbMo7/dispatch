import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { registryFromConfig } from '../asset-registry/configured-assets.js';
import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';

const CLIENT = { authorization: 'Bearer client-token' };
const OPERATOR = { authorization: 'Bearer operator-token' };

async function buildTestApp() {
  const store = new InMemoryDispatchStore();
  const app = buildApp({
    store,
    chainRegistry: await ChainRegistry.load(['base'], {
      base: () => Promise.resolve(new StubChainHandler()),
    }),
    authToken: 'client-token',
    operatorToken: 'operator-token',
    defaultRetryPolicy: false,
    assets: registryFromConfig(),
    readToken: {},
    listSenders: () => Promise.resolve([]),
    readSetup: () => Promise.reject(new Error('not read in this test')),
  });
  return app;
}

type App = Awaited<ReturnType<typeof buildTestApp>>;

const badRecipient = {
  chain: 'base',
  items: [
    { type: 'payment', recipient: 'nope', asset: 'ETH', amount: '1' },
    {
      type: 'payment',
      recipient: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
      asset: 'ETH',
      amount: '2',
    },
  ],
};

function post(app: App, payload: unknown, headers: Record<string, string> = CLIENT) {
  return app.inject({
    method: 'POST',
    url: '/v1/dispatch',
    headers: { ...headers, 'idempotency-key': 'k-1' },
    payload: payload as Record<string, unknown>,
  });
}

async function rejected(app: App) {
  const response = await app.inject({ method: 'GET', url: '/v1/rejected', headers: OPERATOR });
  expect(response.statusCode).toBe(200);
  return response.json<{ rejected: Record<string, unknown>[]; last24Hours: number }>();
}

describe('refused requests (ADR-0062)', () => {
  it('records a refused Dispatch with its key, token, error and every item of its body', async () => {
    const app = await buildTestApp();

    expect((await post(app, badRecipient)).statusCode).toBe(400);

    const { rejected: rows, last24Hours } = await rejected(app);
    expect(rows).toEqual([
      {
        id: expect.any(String) as string,
        at: expect.any(String) as string,
        status: 400,
        chain: 'base',
        idempotencyKey: 'k-1',
        tokenKind: 'auth',
        code: 'INVALID_RECIPIENT',
        message: 'not a well-formed address: nope',
        body: badRecipient,
      },
    ]);
    expect(last24Hours).toBe(1);
  });

  it("records the HTTP server's own refusals and a plain error, with no code for the plain one", async () => {
    const app = await buildTestApp();
    await post(app, { chain: 'ethereum', items: [] });
    await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...OPERATOR, 'content-type': 'application/json' },
      payload: '{"chain":',
    });
    await post(app, { chain: 'base', items: [] });

    const { rejected: rows } = await rejected(app);

    expect(
      rows.map(({ code, message, chain, body, tokenKind }) => ({
        code,
        message,
        chain,
        body,
        tokenKind,
      })),
    ).toEqual([
      {
        code: null,
        message: 'items must be a non-empty array',
        chain: 'base',
        body: { chain: 'base', items: [] },
        tokenKind: 'auth',
      },
      {
        code: 'FST_ERR_CTP_INVALID_JSON_BODY',
        message: expect.any(String) as string,
        chain: null,
        body: null,
        tokenKind: 'operator',
      },
      {
        code: 'FST_ERR_VALIDATION',
        message: 'body/chain must be equal to one of the allowed values',
        chain: null,
        body: { chain: 'ethereum', items: [] },
        tokenKind: 'auth',
      },
    ]);
  });

  it('never records a 401, and records nothing for an accepted Dispatch', async () => {
    const app = await buildTestApp();

    expect((await post(app, badRecipient, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect((await post(app, { chain: 'base', items: [badRecipient.items[1]] })).statusCode).toBe(
      202,
    );

    expect(await rejected(app)).toMatchObject({ rejected: [], last24Hours: 0 });
  });

  it('pages newest first', async () => {
    const app = await buildTestApp();
    for (const recipient of ['a', 'b', 'c']) {
      await post(app, {
        chain: 'base',
        items: [{ type: 'payment', recipient, asset: 'ETH', amount: '1' }],
      });
    }

    const first = await app.inject({
      method: 'GET',
      url: '/v1/rejected?limit=2',
      headers: OPERATOR,
    });
    const { rejected: page, nextCursor } = first.json<{
      rejected: { message: string }[];
      nextCursor: string;
    }>();
    const second = await app.inject({
      method: 'GET',
      url: `/v1/rejected?limit=2&cursor=${nextCursor}`,
      headers: OPERATOR,
    });
    const rest = second.json<{ rejected: { message: string }[]; nextCursor: string | null }>();

    expect([...page, ...rest.rejected].map((r) => r.message.at(-1))).toEqual(['c', 'b', 'a']);
    expect(rest.nextCursor).toBeNull();
  });

  it('answers only the operator token', async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/v1/rejected', headers: CLIENT });
    expect(response.statusCode).toBe(403);
  });
});
