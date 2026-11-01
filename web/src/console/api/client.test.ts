import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient } from './client';

const ID = 'c59cd54c-295c-4948-9120-c20387ad5f09';

function engine(routes: Record<string, { status: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn((path: string, init: RequestInit = {}) => {
    calls.push({ url: path, init });
    const route = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    const [status, body] = route ? [route[1].status, route[1].body] : [404, { error: 'Not Found' }];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).failure;
}

describe('the API client', () => {
  it('sends the bearer token and parses a list page into typed rows', async () => {
    const { fetcher, calls } = engine({
      '/v1/dispatches': {
        status: 200,
        body: {
          dispatches: [
            {
              dispatchId: ID,
              mode: 'managed',
              chain: 'solana',
              sender: { name: 'payouts', address: '9wFd3kQe7RzXbN2pLmV8cTyH5sJaG4uWnE1oKiD6mT3a' },
              status: 'failed',
              createdAt: '2026-10-31T19:06:29.598Z',
              itemCount: 1,
              totals: [{ asset: 'SOL', decimals: 9, amount: '1000000' }],
            },
          ],
          nextCursor: null,
        },
      },
    });
    const api = createApiClient('t0ken', () => {}, fetcher);
    const page = await api.listDispatches(
      { chain: 'solana', sender: 'payouts', status: 'failed' },
      { limit: 5 },
    );
    expect(page.dispatches[0]).toEqual({
      id: ID,
      mode: 'managed',
      chain: 'solana',
      sender: { name: 'payouts', address: '9wFd3kQe7RzXbN2pLmV8cTyH5sJaG4uWnE1oKiD6mT3a' },
      status: 'failed',
      createdAt: new Date('2026-10-31T19:06:29.598Z'),
      itemCount: 1,
      totals: [{ asset: 'SOL', decimals: 9, raw: '1000000' }],
    });
    expect(calls[0]!.url).toBe('/v1/dispatches?limit=5&chain=solana&sender=payouts&status=failed');
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer t0ken');
  });

  it('signs out on a 401', async () => {
    const onUnauthorized = vi.fn();
    const { fetcher } = engine({ '/v1/senders': { status: 401, body: { error: 'unauthorized' } } });
    const api = createApiClient('old', onUnauthorized, fetcher);
    expect(await failure(api.listSenders())).toEqual({ kind: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('reads a 409 ALREADY_CLAIMED as a refusal carrying its code', async () => {
    const { fetcher, calls } = engine({
      [`/v1/dispatch/${ID}/cancel`]: {
        status: 409,
        body: { code: 'ALREADY_CLAIMED', message: 'the engine has already claimed this Dispatch' },
      },
    });
    const api = createApiClient('t', () => {}, fetcher);
    expect(await failure(api.cancelDispatch(ID))).toEqual({
      kind: 'refused',
      status: 409,
      code: 'ALREADY_CLAIMED',
      message: 'the engine has already claimed this Dispatch',
    });
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('turns a body of the wrong shape into a visible error, not a crash', async () => {
    const { fetcher } = engine({
      [`/v1/dispatch/${ID}`]: {
        status: 200,
        body: {
          dispatchId: ID,
          mode: 'managed',
          chain: 'base',
          createdAt: '2026-10-31T19:06:29.598Z',
          status: 'queued',
          items: [{ type: 'payment' }],
        },
      },
    });
    const api = createApiClient('t', () => {}, fetcher);
    expect(await failure(api.getDispatch(ID))).toEqual({
      kind: 'malformed',
      message:
        'items[0].status is not one of queued, held, awaiting_approval, broadcasting, confirmed, failed, abandoned, cancelled',
    });
  });

  it('keeps a degraded Sender field as its error and the rest as values', async () => {
    const { fetcher } = engine({
      '/v1/senders': {
        status: 200,
        body: {
          senders: [
            {
              chain: 'solana',
              name: 'treasury',
              default: false,
              mode: 'squads',
              address: 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv',
              multisig: {
                address: '8xQyR1sT2uV3wX4yZ5a6B7c8D9e1F2g3H4i5J6k7L8m9',
                threshold: { error: 'RPC_UNAVAILABLE' },
                engineKey: '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe',
              },
              balances: [
                {
                  holder: 'vault',
                  address: 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv',
                  assets: [
                    { asset: 'SOL', decimals: 9, balance: '9000000', committed: '0' },
                    {
                      asset: 'USDC',
                      decimals: 6,
                      balance: { error: 'RPC_UNAVAILABLE' },
                      committed: '120',
                    },
                  ],
                },
              ],
              signerKey: { error: 'the Signer could not be reached' },
            },
          ],
        },
      },
    });
    const [sender] = await createApiClient('t', () => {}, fetcher).listSenders();
    expect(sender!.multisig!.threshold).toEqual({ ok: false, error: 'RPC_UNAVAILABLE' });
    expect(sender!.balances[0]!.assets.map((a) => a.balance)).toEqual([
      { ok: true, value: { asset: 'SOL', decimals: 9, raw: '9000000' } },
      { ok: false, error: 'RPC_UNAVAILABLE' },
    ]);
    expect(sender!.signerKey).toEqual({ ok: false, error: 'the Signer could not be reached' });
  });

  it('reads a Signer key the worker has not read yet, and one it has', async () => {
    const base = {
      chain: 'base',
      name: 'default',
      default: true,
      network: 'base-sepolia',
      mode: 'single',
      address: '0x8b21c7D90e4A1f3b5C6d2E9a07B4f81c3D5e44fe',
      multisig: null,
      balances: [],
    };
    const { fetcher } = engine({
      '/v1/senders': {
        status: 200,
        body: {
          senders: [
            { ...base, signerKey: { status: 'not_read_yet' } },
            {
              ...base,
              signerKey: {
                address: '0x8b21c7D90e4A1f3b5C6d2E9a07B4f81c3D5e44fe',
                curve: 'secp256k1',
                readAt: '2026-11-01T09:14:02.511Z',
              },
            },
          ],
        },
      },
    });
    const [unread, read] = await createApiClient('t', () => {}, fetcher).listSenders();
    expect(unread!.signerKey).toEqual({ ok: false, error: 'the worker has not read this key yet' });
    expect(read!.signerKey).toMatchObject({
      ok: true,
      value: { curve: 'secp256k1', readAt: '2026-11-01T09:14:02.511Z' },
    });
  });

  it("reads the setup checks: the worker's run, each check's fix, and where it ran", async () => {
    const { fetcher, calls } = engine({
      '/v1/setup': {
        status: 200,
        body: {
          worker: { status: 'ran', ranAt: '2026-11-01T10:05:00.000Z' },
          summary: { passed: 1, warnings: 0, problems: 1 },
          checks: [
            {
              id: 'signer.reachable',
              area: 'signer',
              title: 'Reachable',
              ranIn: 'worker',
              ranAt: '2026-11-01T10:05:00.000Z',
              status: 'fail',
              finding: 'no Signer answered at SIGNER_URL (signer:8421)',
              fix: { command: 'docker compose up -d signer' },
            },
            {
              id: 'sender.fees:solana',
              area: 'sender',
              title: 'Fee balance (Solana)',
              chain: 'solana',
              ranIn: 'worker',
              ranAt: '2026-11-01T10:05:00.000Z',
              status: 'pass',
              finding: '2.1500 SOL covers the fees paid in the last 24 hours',
            },
          ],
        },
      },
    });
    const setup = await createApiClient('t', () => {}, fetcher).getSetup();
    expect(calls[0]!.url).toBe('/v1/setup');
    expect(setup.worker).toEqual({ status: 'ran', ranAt: new Date('2026-11-01T10:05:00.000Z') });
    expect(setup.checks).toEqual([
      {
        id: 'signer.reachable',
        area: 'signer',
        title: 'Reachable',
        chain: null,
        ranIn: 'worker',
        ranAt: new Date('2026-11-01T10:05:00.000Z'),
        status: 'fail',
        finding: 'no Signer answered at SIGNER_URL (signer:8421)',
        fix: { command: 'docker compose up -d signer' },
      },
      {
        id: 'sender.fees:solana',
        area: 'sender',
        title: 'Fee balance (Solana)',
        chain: 'solana',
        ranIn: 'worker',
        ranAt: new Date('2026-11-01T10:05:00.000Z'),
        status: 'pass',
        finding: '2.1500 SOL covers the fees paid in the last 24 hours',
        fix: null,
      },
    ]);
  });

  it('refuses a setup check that does not say how to fix it', async () => {
    const { fetcher } = engine({
      '/v1/setup': {
        status: 200,
        body: {
          worker: { status: 'not_run_yet' },
          checks: [
            {
              id: 'database.migrated',
              area: 'database',
              title: 'Migrated',
              ranIn: 'api',
              ranAt: '2026-11-01T10:05:00.000Z',
              status: 'fail',
              finding: '1 migration not applied: 0019_setup_checks',
            },
          ],
        },
      },
    });
    expect(await failure(createApiClient('t', () => {}, fetcher).getSetup())).toEqual({
      kind: 'malformed',
      message: 'checks[0].fix is not an object',
    });
  });

  it('reads each Sender by name with which one is the default', async () => {
    const plain = {
      chain: 'solana',
      network: 'devnet',
      mode: 'single',
      multisig: null,
      balances: [],
      signerKey: { status: 'not_read_yet' },
    };
    const { fetcher } = engine({
      '/v1/senders': {
        status: 200,
        body: {
          senders: [
            {
              ...plain,
              name: 'payouts',
              default: true,
              address: '9wFd3kQe7RzXbN2pLmV8cTyH5sJaG4uWnE1oKiD6mT3a',
            },
            {
              ...plain,
              name: 'refunds',
              default: false,
              address: 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv',
            },
          ],
        },
      },
    });
    const senders = await createApiClient('t', () => {}, fetcher).listSenders();
    expect(senders.map((s) => [s.chain, s.name, s.isDefault])).toEqual([
      ['solana', 'payouts', true],
      ['solana', 'refunds', false],
    ]);
  });

  it('refuses a Sender without a name as malformed', async () => {
    const { fetcher } = engine({
      '/v1/senders': {
        status: 200,
        body: {
          senders: [
            {
              chain: 'base',
              default: true,
              network: 'base-sepolia',
              mode: 'single',
              address: '0x8b21c7D90e4A1f3b5C6d2E9a07B4f81c3D5e44fe',
              multisig: null,
              balances: [],
              signerKey: { status: 'not_read_yet' },
            },
          ],
        },
      },
    });
    expect(await failure(createApiClient('t', () => {}, fetcher).listSenders())).toEqual({
      kind: 'malformed',
      message: 'senders[0].name is not a string',
    });
  });

  it("reads a Managed Dispatch's Sender, one no longer configured, and none on a Relay", async () => {
    const managed = {
      mode: 'managed',
      chain: 'solana',
      status: 'confirmed',
      createdAt: '2026-10-31T19:06:29.598Z',
      itemCount: 1,
      totals: [],
    };
    const { fetcher } = engine({
      '/v1/dispatches': {
        status: 200,
        body: {
          dispatches: [
            {
              ...managed,
              dispatchId: ID,
              sender: { name: 'refunds', address: 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv' },
            },
            {
              ...managed,
              dispatchId: ID,
              sender: { name: null, address: '9wFd3kQe7RzXbN2pLmV8cTyH5sJaG4uWnE1oKiD6mT3a' },
            },
            { ...managed, dispatchId: ID, mode: 'relay', transactionHash: null, error: null },
          ],
          nextCursor: null,
        },
      },
    });
    const page = await createApiClient('t', () => {}, fetcher).listDispatches({}, {});
    expect(page.dispatches.map((d) => d.sender)).toEqual([
      { name: 'refunds', address: 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv' },
      { name: null, address: '9wFd3kQe7RzXbN2pLmV8cTyH5sJaG4uWnE1oKiD6mT3a' },
      null,
    ]);
  });

  it("reads a Dispatch's chain and creation time from its own detail, in one request", async () => {
    const { fetcher, calls } = engine({
      [`/v1/dispatch/${ID}`]: {
        status: 200,
        body: {
          dispatchId: ID,
          mode: 'relay',
          chain: 'solana',
          createdAt: '2026-10-31T19:06:29.598Z',
          status: 'queued',
          transactionHash: null,
          error: null,
          timeline: [],
        },
      },
    });
    const detail = await createApiClient('t', () => {}, fetcher).getDispatch(ID);
    expect([detail.chain, detail.createdAt.toISOString()]).toEqual([
      'solana',
      '2026-10-31T19:06:29.598Z',
    ]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['devnet', 'devnet'],
    [{ chainId: 31337 }, { chainId: 31337 }],
    ['some-future-network', 'unknown'],
    [undefined, 'unknown'],
  ])("reads a Sender's network %j as %j", async (network, parsed) => {
    const { fetcher } = engine({
      '/v1/senders': {
        status: 200,
        body: {
          senders: [
            {
              chain: 'solana',
              name: 'payouts',
              default: true,
              network,
              mode: 'single',
              address: 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv',
              multisig: null,
              balances: [],
              signerKey: { error: 'the Signer could not be reached' },
            },
          ],
        },
      },
    });
    const [sender] = await createApiClient('t', () => {}, fetcher).listSenders();
    expect(sender!.network).toEqual(parsed);
  });
});
