import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { SafeTxServiceClient, SafeTxServiceError } from './tx-service-client.js';

const SAFE = '0x84Ac281B68de095f6227050F56C74d93d294e609';
const DELEGATE = '0x2d0b8242f5675eb51965488AC3C2f4038Ad8658E';
const OWNER = '0xE3372Dbf65B13291094F0A3520cb03dB155d8586';
const KEY = 'sk_live_super_secret_key';

type Seen = { url: string; headers: IncomingHttpHeaders };
type Reply = { status: number; body?: unknown; raw?: string; delayMs?: number };

let server: Server | undefined;
afterEach(() => server?.close());

/** A local fake Safe Transaction Service answering every request with `reply(path)`. */
async function startService(
  reply: (url: string) => Reply,
): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const { status, body, raw, delayMs } = reply(req.url ?? '');
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(raw ?? JSON.stringify(body ?? {}));
    }, delayMs ?? 0);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/tx-service/basesep`,
    seen,
  };
}

const safeBody = {
  address: SAFE,
  nonce: '11',
  threshold: 2,
  owners: [OWNER],
  masterCopy: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  modules: [],
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
  guard: '0x0000000000000000000000000000000000000000',
  moduleGuard: '0x0000000000000000000000000000000000000000',
  version: '1.4.1+L2',
};

describe('SafeTxServiceClient', () => {
  it('reads about, the Safe and its delegates from the documented paths', async () => {
    const { baseUrl, seen } = await startService((url) => {
      if (url.endsWith('/api/v1/about/'))
        return {
          status: 200,
          body: { name: 'Safe Transaction Service', version: '6.12.0', extra: 1 },
        };
      if (url.includes('/api/v1/safes/')) return { status: 200, body: safeBody };
      return {
        status: 200,
        body: {
          count: 1,
          results: [
            {
              safe: SAFE,
              delegate: DELEGATE,
              delegator: OWNER,
              label: 'dispatch-engine',
              expiryDate: null,
            },
          ],
        },
      };
    });
    const client = new SafeTxServiceClient({ baseUrl });

    expect(await client.about()).toEqual({ name: 'Safe Transaction Service', version: '6.12.0' });
    expect(await client.getSafe(SAFE)).toMatchObject({
      nonce: '11',
      threshold: 2,
      owners: [OWNER],
      version: '1.4.1+L2',
      modules: [],
    });
    expect(await client.getDelegates(SAFE, DELEGATE)).toEqual([
      {
        safe: SAFE,
        delegate: DELEGATE,
        delegator: OWNER,
        label: 'dispatch-engine',
        expiryDate: null,
      },
    ]);
    expect(seen.map((s) => s.url)).toEqual([
      '/tx-service/basesep/api/v1/about/',
      `/tx-service/basesep/api/v1/safes/${SAFE}/`,
      `/tx-service/basesep/api/v2/delegates/?safe=${SAFE}&delegate=${DELEGATE}`,
    ]);
  });

  it('sends the bearer header only when a key is configured', async () => {
    const { baseUrl, seen } = await startService(() => ({
      status: 200,
      body: { name: 'n', version: 'v' },
    }));
    await new SafeTxServiceClient({ baseUrl }).about();
    await new SafeTxServiceClient({ baseUrl, apiKey: KEY }).about();
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[1]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([
    [401, 'unauthorized', /401.*set BASE_SAFE_API_KEY/],
    [429, 'rate-limited', /429.*unauthenticated limit/],
    [422, 'rejected', /422/],
    [404, 'not-found', /404/],
    [503, 'server-error', /503/],
  ] as const)('maps HTTP %i to %s', async (status, kind, message) => {
    const { baseUrl } = await startService(() => ({ status, body: { detail: 'nope' } }));
    const error = await new SafeTxServiceClient({ baseUrl }).about().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SafeTxServiceError);
    expect(error).toMatchObject({ kind, status });
    expect((error as Error).message).toMatch(message);
  });

  it('tells a keyed 401 and 429 apart from an unkeyed one, and never leaks the key', async () => {
    for (const status of [401, 429]) {
      const { baseUrl } = await startService(() => ({ status, body: { detail: 'bad' } }));
      const error = (await new SafeTxServiceClient({ baseUrl, apiKey: KEY })
        .about()
        .catch((e: unknown) => e)) as SafeTxServiceError;
      expect(error.message).toMatch(
        status === 401 ? /BASE_SAFE_API_KEY was refused/ : /over its rate limit/,
      );
      expect(JSON.stringify(error)).not.toContain(KEY);
      expect(error.message + String(error.stack)).not.toContain(KEY);
      server?.close();
    }
  });

  it('reports an unreachable service without the key', async () => {
    const error = (await new SafeTxServiceClient({ baseUrl: 'http://127.0.0.1:1/x', apiKey: KEY })
      .about()
      .catch((e: unknown) => e)) as SafeTxServiceError;
    expect(error.kind).toBe('unreachable');
    expect(error.message).not.toContain(KEY);
  });

  it('aborts past its per-call deadline', async () => {
    const { baseUrl } = await startService(() => ({
      status: 200,
      body: { name: 'n', version: 'v' },
      delayMs: 500,
    }));
    const error = await new SafeTxServiceClient({ baseUrl, timeoutMs: 50 })
      .about()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'unreachable' });
  });

  it.each([
    ['a non-JSON body', { status: 200, raw: '<html>' }],
    ['a missing field', { status: 200, body: { name: 'n' } }],
  ])('rejects %s as an invalid response', async (_name, reply) => {
    const { baseUrl } = await startService(() => reply);
    await expect(new SafeTxServiceClient({ baseUrl }).about()).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('validates the Safe and delegate shapes at the boundary', async () => {
    const { baseUrl } = await startService((url) =>
      url.includes('/safes/')
        ? { status: 200, body: { ...safeBody, owners: ['not-an-address'] } }
        : {
            status: 200,
            body: {
              results: [
                { safe: SAFE, delegate: 'x', delegator: OWNER, label: 'l', expiryDate: null },
              ],
            },
          },
    );
    const client = new SafeTxServiceClient({ baseUrl });
    await expect(client.getSafe(SAFE)).rejects.toMatchObject({ kind: 'invalid-response' });
    await expect(client.getDelegates(SAFE, DELEGATE)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });
});
