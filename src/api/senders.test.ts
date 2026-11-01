import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import type { Chain } from '../domain/chain.js';
import type { ForeignActivity } from '../domain/sender.js';
import { err, ok } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import type { SignerKeyRecord } from '../repository/dispatch-store.js';
import type { SignerPins } from '../signer/client.js';
import { cachedSenders, type SenderConfig, type SenderReads } from './senders.js';
import { registryFromConfig } from '../asset-registry/configured-assets.js';

const SECRET = 'rpc-key-0123456789';
const READ_AT = new Date('2026-11-01T10:00:00.000Z');

function pinned(chain: Chain, pins: SignerPins): SignerKeyRecord {
  return { chain, address: pins.address, read: { pins }, readAt: READ_AT };
}

const withUsdc = registryFromConfig({
  base: 'USDC:0x036CbD53842c5426634e7929541eC2318f3dCF7e:6',
  solana: 'USDC:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU:6',
});

const plain: SenderConfig = {
  chain: 'base',
  network: 'base-sepolia',
  address: '0xSender',
  assets: withUsdc,
};
const squads: SenderConfig = {
  chain: 'solana',
  network: 'devnet',
  address: 'Vault111',
  assets: withUsdc,
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
  network: { chainId: 31337 },
  address: '0xSafe',
  assets: registryFromConfig(),
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
  signerKeys?: Record<string, SignerKeyRecord>;
  threshold?: Partial<Record<Chain, number>>;
  committed?: Record<string, { asset: string; amount: string }[]>;
  foreign?: Record<string, ForeignActivity>;
  clock?: { now: number };
}) {
  const calls = { getBalance: 0, getSignerKey: 0 };
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
    getSignerKey: (_chain, address) => {
      calls.getSignerKey++;
      return Promise.resolve(options.signerKeys?.[address] ?? null);
    },
    readThreshold: (chain) => {
      const threshold = options.threshold?.[chain];
      return Promise.resolve(
        threshold === undefined ? err({ code: 'RPC_UNAVAILABLE', message: SECRET }) : ok(threshold),
      );
    },
    listCommitted: (chain, holder) =>
      Promise.resolve(options.committed?.[`${chain}:${holder}`] ?? []),
    foreignActivity: (_chain, address, since) => {
      const activity = options.foreign?.[address];
      return Promise.resolve(activity && activity.lastSeenAt >= since ? activity : null);
    },
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
    assets: registryFromConfig(),
    readToken: {},
    listSenders: cachedSenders(configs, reads),
    readSetup: () => Promise.reject(new Error('not read in this test')),
  });
  return app.inject({
    method: 'GET',
    url: '/v1/senders',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /v1/senders (#111)', () => {
  it('reports the nonces another sender used in the last 24 hours (ADR-0064)', async () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const { reads } = fakeReads({
      clock: { now },
      foreign: {
        '0xSender': {
          lastSeenAt: new Date('2026-11-02T11:59:00Z'),
          nonces: [3124, 3126],
          count: 3,
        },
        '0xSafe': {
          lastSeenAt: new Date('2026-11-01T11:00:00Z'),
          nonces: [7, 7],
          count: 1,
        },
      },
    });

    const response = await getSenders([plain, safe], reads);

    const [single, multisig] = response.json<{ senders: { foreignActivity: unknown }[] }>().senders;
    expect(single?.foreignActivity).toEqual({
      lastSeenAt: '2026-11-02T11:59:00.000Z',
      nonces: [3124, 3126],
      count: 3,
    });
    expect(multisig?.foreignActivity).toBeNull();
  });

  it('rejects a request without a valid bearer token', async () => {
    const { reads } = fakeReads({});

    const response = await getSenders([plain], reads, 'wrong');

    expect(response.statusCode).toBe(401);
  });

  it('reports a plain Sender: its balances, nothing committed, and its key as the Signer pins it', async () => {
    const { reads } = fakeReads({
      balances: { '0xSender:ETH': '100', '0xSender:USDC': '50' },
      signerKeys: {
        '0xSender': pinned('base', { address: '0xsender', curve: 'secp256k1', chainIds: [84532] }),
      },
    });

    const response = await getSenders([plain], reads);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      senders: [
        {
          chain: 'base',
          network: 'base-sepolia',
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
          signerKey: {
            address: '0xsender',
            curve: 'secp256k1',
            chainIds: [84532],
            readAt: '2026-11-01T10:00:00.000Z',
          },
          foreignActivity: null,
        },
      ],
    });
  });

  it("reports a Squads Sender's vault and member key, each with what open Proposals hold back", async () => {
    const { reads } = fakeReads({
      balances: { 'Vault111:SOL': '9', 'Vault111:USDC': '500', 'Member111:SOL': '3' },
      signerKeys: {
        Member111: pinned('solana', {
          address: 'Member111',
          curve: 'ed25519',
          allowedMultisig: 'Multisig111',
        }),
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
          network: 'devnet',
          mode: 'squads',
          address: 'Vault111',
          multisig: { address: 'Multisig111', threshold: 2, engineKey: 'Member111' },
          balances: [
            {
              holder: 'vault',
              address: 'Vault111',
              assets: [
                { asset: 'SOL', decimals: 9, balance: '9', committed: '0' },
                { asset: 'USDC', decimals: 6, balance: '500', committed: '120' },
              ],
            },
            {
              holder: 'memberKey',
              address: 'Member111',
              assets: [{ asset: 'SOL', decimals: 9, balance: '3', committed: '2' }],
            },
          ],
          signerKey: {
            address: 'Member111',
            curve: 'ed25519',
            allowedMultisig: 'Multisig111',
            readAt: '2026-11-01T10:00:00.000Z',
          },
          foreignActivity: null,
        },
      ],
    });
  });

  it("reports a Safe Sender's Safe and executor", async () => {
    const { reads } = fakeReads({
      balances: { '0xSafe:ETH': '7', '0xExecutor:ETH': '1' },
      signerKeys: {
        '0xExecutor': {
          ...pinned('base', { address: '0xexecutor', curve: 'secp256k1', allowedSafe: '0xsafe' }),
          address: '0xExecutor',
        },
      },
      threshold: { base: 3 },
    });

    const response = await getSenders([safe], reads);

    expect(response.json()).toMatchObject({
      senders: [
        {
          network: { chainId: 31337 },
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
          signerKey: { status: 'not_read_yet' },
        },
      ],
    });
    expect(response.body).not.toContain(SECRET);
  });

  it('reads the chain and the recorded Signer key once per 15 seconds, however often it is asked', async () => {
    const clock = { now: 0 };
    const { reads, calls } = fakeReads({ balances: { '0xSender:ETH': '1' }, clock });
    const listSenders = cachedSenders([plain], reads);

    await listSenders();
    clock.now = 14_999;
    await listSenders();
    const withinWindow = { ...calls };
    clock.now = 15_000;
    await listSenders();

    expect(withinWindow).toEqual({ getBalance: 2, getSignerKey: 1 });
    expect(calls).toEqual({ getBalance: 4, getSignerKey: 2 });
  });
});
