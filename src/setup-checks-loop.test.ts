import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SetupView } from './api/setup-routes.js';
import { setupReader } from './api/setup-routes.js';
import { buildApp } from './app.js';
import { ChainRegistry } from './chain-registry/chain-registry.js';
import { InMemoryDispatchStore } from './repository/in-memory-dispatch-store.js';
import { apiSetupChecks } from './setup/api-checks.js';
import { CHECKS } from './setup/checks.js';
import { planChecks, runPlanned } from './setup/run.js';
import { fakeContext, goodEnv } from './setup/test-support/fake-context.js';
import { SETUP_CHECKS_TICK_MS, setupChecksLoop } from './setup-checks-loop.js';
import { SignerClient } from './signer/client.js';

const TOKEN = 'signer-token-0123456789abcdef0123456789';
const START = Date.parse('2026-11-01T10:00:00.000Z');

let signer: Server;
let signerUrl: string;
let received: IncomingMessage[];
let refuse: boolean;

beforeEach(async () => {
  received = [];
  refuse = false;
  signer = createServer((request, response) => {
    received.push(request);
    const address = decodeURIComponent(request.url?.split('/')[2] ?? '');
    response
      .writeHead(refuse ? 401 : 200, { 'content-type': 'application/json' })
      .end(refuse ? '{"error":"unauthorized"}' : JSON.stringify({ address, curve: 'ed25519' }));
  });
  await new Promise<void>((resolve) => signer.listen(0, '127.0.0.1', resolve));
  signerUrl = `http://127.0.0.1:${(signer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => signer.close(resolve));
});

/**
 * The API and the worker as `index.ts` and `worker.ts` wire them, over one
 * store. Both are configured with the Signer's URL and token, so only the
 * code decides which of them calls it.
 */
async function engine({ workerSignerUrl }: { workerSignerUrl?: string } = {}) {
  const clock = { now: START };
  const now = () => new Date(clock.now);
  const env = goodEnv({
    ENABLED_CHAINS: 'solana',
    BASE_SENDER_ADDRESS: '',
    SIGNER_URL: signerUrl,
    SIGNER_AUTH_TOKEN: TOKEN,
  });
  const store = new InMemoryDispatchStore();
  const database = {
    ping: () => Promise.resolve(),
    pendingMigrations: () => Promise.resolve([]),
    recentTransactions: () => Promise.resolve({ count: 0, latestHashes: [] }),
  };
  const app = buildApp({
    store,
    chainRegistry: await ChainRegistry.load([], {}),
    authToken: 'api-token',
    defaultRetryPolicy: false,
    assetDecimals: () => 9,
    listSenders: () => Promise.resolve([]),
    readSetup: setupReader({
      enabledChains: ['solana'],
      listRecorded: () => store.listSetupChecks(),
      runApiChecks: apiSetupChecks(env, database, { consoleBuilt: () => true }),
      now,
    }),
  });
  const getSetup = async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/setup',
      headers: { authorization: 'Bearer api-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(TOKEN);
    return response.json<SetupView>();
  };
  const worker = fakeContext(env, {
    signer: {
      readPins: (address) =>
        new SignerClient(workerSignerUrl ?? signerUrl, TOKEN, 2_000).readPins(address),
    },
  });
  const afterSleep: (() => Promise<void>)[] = [];
  const runWorker = (ticks: number) => {
    const slept: number[] = [];
    return setupChecksLoop({
      runChecks: () => runPlanned(planChecks(CHECKS, worker, { place: 'worker' })),
      store,
      now,
      logger: pino({ level: 'silent' }),
      isRunning: () => slept.length < ticks,
      sleep: async (ms) => {
        slept.push(ms);
        clock.now += ms;
        await afterSleep[slept.length - 1]?.();
      },
    }).then(() => slept);
  };
  return { getSetup, runWorker, afterSleep };
}

const ranIn = (view: SetupView) => view.checks.map(({ id, ranIn }) => `${ranIn} ${id}`);
const check = (view: SetupView, id: string) => view.checks.find((c) => c.id === id);

describe('GET /v1/setup (#137)', () => {
  it("on a fresh install, says the worker has not run yet and serves only the API's own checks, never asking the Signer", async () => {
    const { getSetup } = await engine();

    const view = await getSetup();

    expect(view.worker).toEqual({ status: 'not_run_yet' });
    expect(ranIn(view)).toEqual([
      'api database.reachable',
      'api database.migrated',
      'api console.built',
    ]);
    expect(view.summary).toEqual({ passed: 3, warnings: 0, problems: 0 });
    expect(received).toHaveLength(0);
  });

  it("serves the worker's recorded run beside the API's checks, in report order, all passing", async () => {
    const { getSetup, runWorker } = await engine();

    await runWorker(1);
    const readsByWorker = received.length;
    const view = await getSetup();

    expect(readsByWorker).toBeGreaterThan(0);
    expect(received).toHaveLength(readsByWorker);
    expect(view.worker).toEqual({ status: 'ran', ranAt: '2026-11-01T10:00:00.000Z' });
    expect(ranIn(view)).toEqual([
      'worker configuration.environment',
      'worker configuration.tokens',
      'worker configuration.chains',
      'api database.reachable',
      'api database.migrated',
      'worker chain.rpc:solana',
      'worker chain.network:solana',
      'worker signer.reachable',
      'worker signer.key:solana',
      'worker sender.fees:solana',
      'worker sender.tokens:solana',
      'api console.built',
    ]);
    expect(view.summary).toEqual({ passed: 12, warnings: 0, problems: 0 });
    expect(check(view, 'signer.key:solana')).toMatchObject({
      chain: 'solana',
      status: 'pass',
      ranAt: '2026-11-01T10:00:00.000Z',
    });
  });

  it('reports a stopped Signer as a failing check with its fix, and the key it could not ask about as not checked', async () => {
    const { getSetup, runWorker } = await engine({ workerSignerUrl: 'http://127.0.0.1:9' });

    await runWorker(1);
    const view = await getSetup();

    expect(check(view, 'signer.reachable')).toMatchObject({
      status: 'fail',
      finding: expect.stringContaining('no Signer answered') as unknown,
      fix: { command: 'docker compose up -d signer' },
    });
    expect(check(view, 'signer.key:solana')).toMatchObject({
      status: 'warn',
      finding: expect.stringMatching(/^not checked/) as unknown,
    });
    expect(view.summary).toMatchObject({ problems: 1, warnings: 1 });
  });

  it("runs again every five minutes, and the API serves only the latest run's results", async () => {
    const { getSetup, runWorker, afterSleep } = await engine();
    refuse = true;
    let afterFirstRun: SetupView | undefined;
    afterSleep.push(async () => {
      afterFirstRun = await getSetup();
      refuse = false;
    });

    const slept = await runWorker(2);
    const latest = await getSetup();

    expect(slept).toEqual([SETUP_CHECKS_TICK_MS, SETUP_CHECKS_TICK_MS]);
    expect(check(afterFirstRun!, 'signer.reachable')).toMatchObject({
      status: 'fail',
      fix: { setting: 'SIGNER_AUTH_TOKEN' },
    });
    expect(latest.worker).toEqual({
      status: 'ran',
      ranAt: new Date(START + SETUP_CHECKS_TICK_MS).toISOString(),
    });
    expect(check(latest, 'signer.reachable')?.status).toBe('pass');
  });
});
