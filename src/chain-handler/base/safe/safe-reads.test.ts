import { describe, expect, it } from 'vitest';

import { SAFE_GUARD_STORAGE_SLOT, readSafeState, type SafeReadClient } from './safe-reads.js';

const SAFE = '0x84Ac281B68de095f6227050F56C74d93d294e609';
const OWNER = '0xE3372Dbf65B13291094F0A3520cb03dB155d8586';
const GUARD = '0xA849e67B662129912513E2A8017B437f4251c0a5';
const MODULE = '0x461BAfEb8A9cbe40f399aF907180A75b2c7cCb7C';

type Call = { method: string; blockNumber?: bigint | undefined; functionName?: string };

/** A fake chain client that records which block every read was pinned to. */
function fakeClient(
  state: { code?: `0x${string}`; guardSlot?: `0x${string}`; modules?: string[] } = {},
) {
  const calls: Call[] = [];
  let latest = 500n;
  const client = {
    getChainId: () => Promise.resolve(84532),
    getBlockNumber: () => {
      calls.push({ method: 'getBlockNumber' });
      return Promise.resolve(latest++);
    },
    getCode: (args: { blockNumber?: bigint }) => {
      calls.push({ method: 'getCode', blockNumber: args.blockNumber });
      return Promise.resolve(state.code ?? '0x6080');
    },
    getStorageAt: (args: { slot: string; blockNumber?: bigint }) => {
      calls.push({ method: `getStorageAt:${args.slot}`, blockNumber: args.blockNumber });
      return Promise.resolve(
        state.guardSlot ?? '0x0000000000000000000000000000000000000000000000000000000000000000',
      );
    },
    readContract: (args: { functionName: string; blockNumber?: bigint }) => {
      calls.push({
        method: 'readContract',
        functionName: args.functionName,
        blockNumber: args.blockNumber,
      });
      switch (args.functionName) {
        case 'VERSION':
          return Promise.resolve('1.4.1');
        case 'getOwners':
          return Promise.resolve([OWNER]);
        case 'getThreshold':
          return Promise.resolve(2n);
        case 'nonce':
          return Promise.resolve(11n);
        default:
          return Promise.resolve([
            state.modules ?? [],
            '0x0000000000000000000000000000000000000001',
          ]);
      }
    },
  };
  return { client: client as unknown as SafeReadClient, calls };
}

describe('readSafeState', () => {
  it('reads the Safe, pinning every read to the one block read up front', async () => {
    const { client, calls } = fakeClient();
    const state = await readSafeState(client, SAFE);

    expect(state).toEqual({
      blockNumber: 500n,
      chainId: 84532,
      hasCode: true,
      version: '1.4.1',
      owners: [OWNER],
      threshold: 2,
      nonce: 11n,
      guard: '0x0000000000000000000000000000000000000000',
      modules: [],
    });
    expect(calls.filter((c) => c.method === 'getBlockNumber')).toHaveLength(1);
    const reads = calls.filter((c) => c.method !== 'getBlockNumber');
    expect(reads.map((c) => c.functionName ?? c.method)).toEqual(
      expect.arrayContaining([
        'getCode',
        'VERSION',
        'getOwners',
        'getThreshold',
        'nonce',
        'getModulesPaginated',
        `getStorageAt:${SAFE_GUARD_STORAGE_SLOT}`,
      ]),
    );
    expect(reads.every((c) => c.blockNumber === 500n)).toBe(true);
  });

  it('reports a missing contract without reading anything else', async () => {
    const { client, calls } = fakeClient({ code: '0x' });
    const state = await readSafeState(client, SAFE);
    expect(state.hasCode).toBe(false);
    expect(calls.some((c) => c.method === 'readContract')).toBe(false);
  });

  it('decodes a guard from the storage slot and lists modules', async () => {
    const { client } = fakeClient({
      guardSlot: `0x000000000000000000000000${GUARD.slice(2).toLowerCase()}`,
      modules: [MODULE],
    });
    const state = await readSafeState(client, SAFE);
    expect(state.guard.toLowerCase()).toBe(GUARD.toLowerCase());
    expect(state.modules).toEqual([MODULE]);
  });
});
