import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import type { SetupCheckRecord } from '../repository/dispatch-store.js';
import type { CheckOutcome } from '../setup/run.js';
import { setupReader, type SetupReads, type SetupView } from './setup-routes.js';
import { registryFromConfig } from '../asset-registry/configured-assets.js';

const RAN_AT = new Date('2026-11-01T10:00:00.000Z');
const NOW = new Date('2026-11-01T10:02:30.000Z');

const record = (id: string, chain?: 'solana' | 'base'): SetupCheckRecord => ({
  id: chain ? `${id}:${chain}` : id,
  area: id.startsWith('chain') ? 'chain' : 'signer',
  title: id,
  ...(chain ? { chain } : {}),
  result: { status: 'pass', finding: 'fine' },
  ranAt: RAN_AT,
});

const databaseDown: CheckOutcome = {
  id: 'database.reachable',
  area: 'database',
  title: 'Reachable',
  result: {
    status: 'fail',
    finding: 'could not reach the database at db:5432/dispatch (DATABASE_URL): ECONNREFUSED',
    fix: { command: 'docker compose up -d postgres' },
  },
};

async function getSetup(reads: Partial<SetupReads>, token = 'api-token') {
  const app = buildApp({
    store: new InMemoryDispatchStore(),
    chainRegistry: await ChainRegistry.load([], {}),
    authToken: 'api-token',
    defaultRetryPolicy: false,
    assets: registryFromConfig(),
    readToken: {},
    listSenders: () => Promise.resolve([]),
    readSetup: setupReader({
      enabledChains: ['solana', 'base'],
      listRecorded: () => Promise.resolve([]),
      runApiChecks: () => Promise.resolve([]),
      now: () => NOW,
      ...reads,
    }),
  });
  return app.inject({
    method: 'GET',
    url: '/v1/setup',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /v1/setup (#137)', () => {
  it('rejects a request without a valid bearer token', async () => {
    const response = await getSetup({}, 'wrong');

    expect(response.statusCode).toBe(401);
  });

  it('leaves out a recorded check for a chain the engine no longer enables, and orders chains as enabled', async () => {
    const response = await getSetup({
      enabledChains: ['base', 'solana'],
      listRecorded: () =>
        Promise.resolve([
          record('chain.rpc', 'solana'),
          record('signer.reachable'),
          record('chain.rpc', 'base'),
          record('chain.network', 'base'),
        ]),
    });
    const later = await getSetup({
      enabledChains: ['solana'],
      listRecorded: () =>
        Promise.resolve([record('chain.rpc', 'solana'), record('chain.rpc', 'base')]),
    });

    expect(response.json<SetupView>().checks.map((c) => c.id)).toEqual([
      'chain.rpc:base',
      'chain.rpc:solana',
      'chain.network:base',
      'signer.reachable',
    ]);
    expect(later.json<SetupView>().checks.map((c) => c.id)).toEqual(['chain.rpc:solana']);
  });

  it("still answers when the database is down: the worker's record is unreadable and the API's own check says why", async () => {
    const response = await getSetup({
      listRecorded: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.4:5432')),
      runApiChecks: () => Promise.resolve([databaseDown]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      worker: { status: 'unreadable' },
      summary: { passed: 0, warnings: 0, problems: 1 },
      checks: [
        {
          id: 'database.reachable',
          area: 'database',
          title: 'Reachable',
          ranIn: 'api',
          ranAt: NOW.toISOString(),
          status: 'fail',
          finding: databaseDown.result.finding,
          fix: { command: 'docker compose up -d postgres' },
        },
      ],
    });
  });
});
