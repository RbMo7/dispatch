import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cachedSenders, SENDERS_CACHE_MS, type SenderConfig } from './api/senders.js';
import { buildApp } from './app.js';
import { ChainRegistry } from './chain-registry/chain-registry.js';
import { ok } from './domain/result.js';
import { InMemoryDispatchStore } from './repository/in-memory-dispatch-store.js';
import { SignerClient } from './signer/client.js';
import { SIGNER_KEYS_TICK_MS, signerKeysLoop } from './signer-keys-loop.js';

const TOKEN = 'signer-token-0123456789';
const LEAK = 'internal-detail-9876543210';

const sender: SenderConfig = {
  chain: 'base',
  network: 'base-sepolia',
  address: '0xSender',
  assets: ['ETH'],
  assetDecimals: () => 18,
};

type Answer = { status: number; body: string };
const pinsAnswer: Answer = {
  status: 200,
  body: JSON.stringify({ address: '0xsender', curve: 'secp256k1', chainIds: [84532] }),
};

let signer: Server;
let signerUrl: string;
let received: IncomingMessage[];
let answers: Answer[];

beforeEach(async () => {
  received = [];
  answers = [];
  signer = createServer((request, response) => {
    received.push(request);
    const answer = answers.shift() ?? pinsAnswer;
    response.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
  });
  await new Promise<void>((resolve) => signer.listen(0, '127.0.0.1', resolve));
  signerUrl = `http://127.0.0.1:${(signer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => signer.close(resolve));
});

async function engine() {
  const clock = { now: Date.parse('2026-11-01T10:00:00.000Z') };
  const now = () => new Date(clock.now);
  const store = new InMemoryDispatchStore();
  const app = buildApp({
    store,
    chainRegistry: await ChainRegistry.load([], {}),
    authToken: 'api-token',
    defaultRetryPolicy: false,
    assetDecimals: () => 18,
    listSenders: cachedSenders([sender], {
      getBalance: (_chain, _address, asset) => Promise.resolve(ok({ asset, amount: '1' })),
      getSignerKey: (chain, address) => store.getSignerKey(chain, address),
      readThreshold: () => Promise.resolve(ok(1)),
      listCommitted: () => Promise.resolve([]),
      now,
    }),
    readSetup: () => Promise.reject(new Error('not read in this test')),
  });
  const getSignerKey = async () => {
    clock.now += SENDERS_CACHE_MS;
    const response = await app.inject({
      method: 'GET',
      url: '/v1/senders',
      headers: { authorization: 'Bearer api-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(TOKEN);
    expect(response.body).not.toContain(LEAK);
    return response.json<{ senders: { signerKey: unknown }[] }>().senders[0]?.signerKey;
  };
  const runWorker = (ticks: number) => {
    const slept: number[] = [];
    return signerKeysLoop({
      keys: [{ chain: 'base', address: '0xSender' }],
      readPins: (address) => new SignerClient(signerUrl, TOKEN).readPins(address),
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
  const afterSleep: (() => Promise<void>)[] = [];
  return { getSignerKey, runWorker, afterSleep };
}

describe('Signer key pins (ADR-0059)', () => {
  it('the API reports a key not read yet, and never asks the Signer', async () => {
    const { getSignerKey } = await engine();

    expect(await getSignerKey()).toEqual({ status: 'not_read_yet' });
    expect(await getSignerKey()).toEqual({ status: 'not_read_yet' });
    expect(received).toHaveLength(0);
  });

  it("the worker's read is what the API reports, with when it was read", async () => {
    const { getSignerKey, runWorker } = await engine();

    await runWorker(1);
    const readsByWorker = received.length;
    const signerKey = await getSignerKey();

    expect(readsByWorker).toBe(1);
    expect(received[0]?.url).toBe('/keys/0xSender/policy');
    expect(received[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(signerKey).toEqual({
      address: '0xsender',
      curve: 'secp256k1',
      chainIds: [84532],
      readAt: '2026-11-01T10:00:00.000Z',
    });
    expect(received).toHaveLength(readsByWorker);
  });

  it('records a failed read as a fixed reason, never what the Signer said', async () => {
    const { getSignerKey, runWorker } = await engine();
    answers.push({ status: 500, body: `{"error":"${LEAK} ${TOKEN}"}` });

    await runWorker(1);

    expect(await getSignerKey()).toEqual({
      error: 'the Signer could not be reached',
      readAt: '2026-11-01T10:00:00.000Z',
    });
  });

  it('reads again every five minutes, and a later success replaces the error', async () => {
    const { getSignerKey, runWorker, afterSleep } = await engine();
    answers.push({ status: 404, body: '{"error":"no key for address 0xSender"}' });
    let afterFirstRead: unknown;
    afterSleep.push(async () => {
      afterFirstRead = await getSignerKey();
    });

    const slept = await runWorker(2);

    expect(slept).toEqual([SIGNER_KEYS_TICK_MS, SIGNER_KEYS_TICK_MS]);
    expect(afterFirstRead).toEqual({
      error: 'the Signer has no key for this address',
      readAt: '2026-11-01T10:00:00.000Z',
    });
    expect(received).toHaveLength(2);
    expect(await getSignerKey()).toMatchObject({
      address: '0xsender',
      readAt: new Date(
        Date.parse('2026-11-01T10:00:00.000Z') + SENDERS_CACHE_MS + SIGNER_KEYS_TICK_MS,
      ).toISOString(),
    });
  });
});
