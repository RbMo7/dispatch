import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import type { Chain } from '../domain/chain.js';
import { err, ok } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import type { PolicyRead } from '../signer/client.js';
import { cachedSenders, type SenderConfig, type SenderReads } from './senders.js';

const SECRET = 'rpc-key-0123456789';

const assetDecimals: SenderConfig['assetDecimals'] = (_chain, asset) =>
  ({ ETH: 18, USDC: 6 })[asset as 'ETH' | 'USDC'];

const plain: SenderConfig = {
  chain: 'base',
  address: '0xSender',
  assets: ['ETH', 'USDC'],
  assetDecimals,
};
const squads: SenderConfig = {
  chain: 'solana',
  address: 'Vault111',
  assets: ['SOL', 'USDC'],
  assetDecimals,
  approval: {
    mode: 'squads',
    multisigAddress: 'Multisig111',
    engineKey: 'Member111',
    holders: { sender: 'vault', proposer: 'memberKey' },
    rewatchWindowMs: 1_000,
  },
};
const safe: SenderConfig = {
  chain: 'base',
  address: '0xSafe',
  assets: ['ETH'],
  assetDecimals,
  approval: {
    mode: 'safe',
    multisigAddress: '0xSafe',
    engineKey: '0xExecutor',
    holders: { sender: 'safe', proposer: 'executor' },
    rewatchWindowMs: 1_000,
  },
};

function fakeReads(options: {
  balances?: Record<string, string>;
  pins?: Record<string, PolicyRead>;
  threshold?: Partial<Record<Chain, number>>;
  committed?: Record<string, { asset: string; amount: string }[]>;
  clock?: { now: number };
}) {
  const calls = { getBalance: 0, readPins: 0 };
  const reads: SenderReads = {
    getBalance: (_chain, address, asset) => {
      calls.getBalance++;
      const amount = options.balances?.[`${address}:${asset}`];
      return Promise.resolve(
        amount === undefined
          ? err({ code: 'RPC_UNAVAILABLE', message: `https://rpc.example/${SECRET} timed out` })
          : ok({ asset, amount }),
      );
    },
    readPins: (address) => {
      calls.readPins++;
      return Promise.resolve(
        options.pins?.[address] ?? {
          kind: 'unreachable',
          message: `failed to reach signer at http://user:${SECRET}@signer`,
        },
      );
    },
    readThreshold: (chain) => {
      const threshold = options.threshold?.[chain];
      return Promise.resolve(
        threshold === undefined ? err({ code: 'RPC_UNAVAILABLE', message: SECRET }) : ok(threshold),
      );
    },
    listCommitted: (chain, holder) =>
      Promise.resolve(options.committed?.[`${chain}:${holder}`] ?? []),
    now: () => new Date(options.clock?.now ?? 0),
  };
  return { reads, calls };
}

async function getSenders(configs: SenderConfig[], reads: SenderReads, token = 'test-token') {
  const app = buildApp({
    store: new InMemoryDispatchStore(),
    chainRegistry: await ChainRegistry.load([], {}),
    authToken: 'test-token',
    defaultRetryPolicy: false,
    assetDecimals: () => undefined,
    listSenders: cachedSenders(configs, reads),
  });
  return app.inject({
    method: 'GET',
    url: '/v1/senders',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /v1/senders (#111)', () => {
  it('rejects a request without a valid bearer token', async () => {
    const { reads } = fakeReads({});

    const response = await getSenders([plain], reads, 'wrong');

    expect(response.statusCode).toBe(401);
  });

  it('reports a plain Sender: its balances, nothing committed, and its key as the Signer pins it', async () => {
    const { reads } = fakeReads({
      balances: { '0xSender:ETH': '100', '0xSender:USDC': '50' },
      pins: {
        '0xSender': {
          kind: 'pins',
          pins: { address: '0xsender', curve: 'secp256k1', chainIds: [84532] },
        },
      },
    });

    const response = await getSenders([plain], reads);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      senders: [
        {
          chain: 'base',
          mode: 'single',
          address: '0xSender',
          multisig: null,
          balances: [
            {
              holder: 'sender',
              address: '0xSender',
              assets: [
                { asset: 'ETH', decimals: 18, balance: '100', committed: '0' },
                { asset: 'USDC', decimals: 6, balance: '50', committed: '0' },
              ],
            },
          ],
          signerKey: { address: '0xsender', curve: 'secp256k1', chainIds: [84532] },
        },
      ],
    });
  });

  it("reports a Squads Sender's vault and member key, each with what open Proposals hold back", async () => {
    const { reads } = fakeReads({
      balances: { 'Vault111:SOL': '9', 'Vault111:USDC': '500', 'Member111:SOL': '3' },
      pins: {
        Member111: {
          kind: 'pins',
          pins: { address: 'Member111', curve: 'ed25519', allowedMultisig: 'Multisig111' },
        },
      },
      threshold: { solana: 2 },
      committed: {
        'solana:sender': [{ asset: 'USDC', amount: '120' }],
        'solana:proposer': [{ asset: 'SOL', amount: '2' }],
      },
    });

    const response = await getSenders([squads], reads);

    expect(response.json()).toEqual({
      senders: [
        {
          chain: 'solana',
          mode: 'squads',
          address: 'Vault111',
          multisig: { address: 'Multisig111', threshold: 2, engineKey: 'Member111' },
          balances: [
            {
              holder: 'vault',
              address: 'Vault111',
              assets: [
                { asset: 'SOL', balance: '9', committed: '0' },
                { asset: 'USDC', decimals: 6, balance: '500', committed: '120' },
              ],
            },
            {
              holder: 'memberKey',
              address: 'Member111',
              assets: [{ asset: 'SOL', balance: '3', committed: '2' }],
            },
          ],
          signerKey: { address: 'Member111', curve: 'ed25519', allowedMultisig: 'Multisig111' },
        },
      ],
    });
  });

  it("reports a Safe Sender's Safe and executor", async () => {
    const { reads } = fakeReads({
      balances: { '0xSafe:ETH': '7', '0xExecutor:ETH': '1' },
      pins: {
        '0xExecutor': {
          kind: 'pins',
          pins: { address: '0xexecutor', curve: 'secp256k1', allowedSafe: '0xsafe' },
        },
      },
      threshold: { base: 3 },
    });

    const response = await getSenders([safe], reads);

    expect(response.json()).toMatchObject({
      senders: [
        {
          mode: 'safe',
          multisig: { address: '0xSafe', threshold: 3, engineKey: '0xExecutor' },
          balances: [
            { holder: 'safe', assets: [{ asset: 'ETH', balance: '7' }] },
            { holder: 'executor', assets: [{ asset: 'ETH', balance: '1' }] },
          ],
          signerKey: { allowedSafe: '0xsafe' },
        },
      ],
    });
  });

  it('degrades only the field whose read failed, and never echoes what the failure said', async () => {
    const { reads } = fakeReads({ balances: { 'Vault111:SOL': '9' } });

    const response = await getSenders([squads], reads);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      senders: [
        {
          multisig: { threshold: { error: 'RPC_UNAVAILABLE' } },
          balances: [
            {
              holder: 'vault',
              assets: [
                { asset: 'SOL', balance: '9' },
                { asset: 'USDC', balance: { error: 'RPC_UNAVAILABLE' } },
              ],
            },
            { holder: 'memberKey', assets: [{ balance: { error: 'RPC_UNAVAILABLE' } }] },
          ],
          signerKey: { error: 'the Signer could not be reached' },
        },
      ],
    });
    expect(response.body).not.toContain(SECRET);
  });

  it('reads the chain and the Signer once per 15 seconds, however often it is asked', async () => {
    const clock = { now: 0 };
    const { reads, calls } = fakeReads({ balances: { '0xSender:ETH': '1' }, clock });
    const listSenders = cachedSenders([plain], reads);

    await listSenders();
    clock.now = 14_999;
    await listSenders();
    const withinWindow = { ...calls };
    clock.now = 15_000;
    await listSenders();

    expect(withinWindow).toEqual({ getBalance: 2, readPins: 1 });
    expect(calls).toEqual({ getBalance: 4, readPins: 2 });
  });
});
