import { describe, expect, it } from 'vitest';

import { parseDetail, parsePage } from '../console/api/parse';
import { callSignature, targetName, undecodedLine } from './calls';
import type { CallItem, LoadedDispatch } from './dispatch';
import { dispatchFlow } from './dispatchFlow';

const ID = '7f3a91c2-0b1e-4c55-9a7e-2d41f0c3b8e6';
const VAULT = '0x79bB95AEF7f032144A9A5C6933B8d13a98e6D793';
const PAYOUTS = '0x8cdBF57d39066712E9eDADb0822D7b89E7699e06';
const HASH = '0x5b0e8d4c1f7a2e9b3d6c8a0f4e1b7d2c9a5e3f8b0d6c4a1e7f2b9d3c5a8e0f6b';
const ETH = { address: 'native', symbol: 'ETH', name: 'Ether', decimals: 18 };

/** Row 4 of the flows, as the engine answers it once FlowVault's ABI is registered (docs/openapi.yaml). */
const explained = {
  type: 'call',
  to: VAULT,
  call: {
    target: VAULT,
    label: 'FlowVault',
    decoded: true,
    decoder: 'abi',
    function: 'deposit',
    args: [{ name: 'note', type: 'string', value: 'flows row 4' }],
    selector: '0xa26e1186',
    value: { amount: '1000000000000', asset: ETH, formatted: '0.000001' },
  },
  status: 'confirmed',
  transactionHash: HASH,
  error: null,
  effects: {
    transfers: [
      {
        standard: 'native',
        token: 'native',
        from: PAYOUTS,
        to: VAULT,
        amount: '1000000000000',
        asset: ETH,
        formatted: '0.000001',
      },
    ],
    value: { amount: '1000000000000', asset: ETH, formatted: '0.000001' },
    fee: { amount: '2148090906', asset: ETH, formatted: '0.000000002148090906', payer: PAYOUTS },
    events: [
      {
        kind: 'log',
        source: VAULT,
        label: 'FlowVault',
        decoder: 'abi',
        name: 'Deposited',
        args: [
          { name: 'from', type: 'address', value: PAYOUTS },
          { name: 'amount', type: 'uint256', value: '1000000000000' },
          { name: 'note', type: 'string', value: 'flows row 4' },
        ],
      },
    ],
    undecodedEvents: 0,
    undecodedEventSources: [],
    truncated: false,
  },
};

/** The same call before any ABI: its selector, raw data, and one event no one explains. */
const undecoded = {
  ...explained,
  call: {
    target: VAULT,
    decoded: false,
    selector: '0xa26e1186',
    data: '0xa26e1186',
    value: explained.call.value,
  },
  effects: {
    ...explained.effects,
    events: [],
    undecodedEvents: 1,
    undecodedEventSources: [{ source: VAULT, count: 1 }],
  },
};

function load(item: object): LoadedDispatch {
  const created = '2026-11-01T16:20:00.000Z';
  const page = parsePage({
    dispatches: [
      {
        dispatchId: ID,
        mode: 'managed',
        chain: 'base',
        status: 'confirmed',
        createdAt: created,
        itemCount: 1,
        totals: [],
      },
    ],
    nextCursor: null,
  });
  return {
    summary: page.dispatches[0]!,
    detail: parseDetail({
      dispatchId: ID,
      mode: 'managed',
      chain: 'base',
      status: 'confirmed',
      createdAt: created,
      items: [item],
      timeline: [
        { at: created, kind: 'created' },
        { at: '2026-11-01T16:20:01.000Z', kind: 'claimed' },
        { at: '2026-11-01T16:20:02.000Z', kind: 'written', hash: HASH, items: [0], replaces: null },
        { at: '2026-11-01T16:20:04.000Z', kind: 'confirmed', hash: HASH, items: [0] },
      ],
    }),
  };
}

const callOf = (loaded: LoadedDispatch) =>
  (loaded.detail.mode === 'managed' ? loaded.detail.items[0] : undefined) as CallItem;

const clock = { now: new Date('2026-11-01T16:21:00.000Z'), time: (at: Date) => at.toISOString() };
const sent = (loaded: LoadedDispatch) =>
  dispatchFlow(loaded, clock, 'base-sepolia').stages.find((s) => s.title === 'Signed and sent')!;

describe('a call as the console reads it (ADR-0063)', () => {
  it('names a registered call by its label, function and arguments, with its value in ETH', () => {
    const { call, effects } = callOf(load(explained));

    expect(targetName(call)).toBe('FlowVault');
    expect(callSignature(call)).toBe('deposit(note: "flows row 4")');
    expect(call.value?.money).toEqual({
      raw: '1000000000000',
      decimals: 18,
      asset: 'ETH',
      name: 'Ether',
    });
    expect(effects?.events.map((e) => [e.label, e.name])).toEqual([['FlowVault', 'Deposited']]);
  });

  it('falls back to the shortened address and says what has no ABI', () => {
    const { call, effects } = callOf(load(undecoded));

    expect(targetName(call)).toBe('0x79bB…D793');
    expect(callSignature(call)).toBeNull();
    expect(undecodedLine('base', effects!.undecodedEvents)).toBe('1 event with no ABI');
    expect(undecodedLine('solana', 3)).toBe('3 instructions with no IDL');
  });

  it("names the function in a single call's Signed and sent stage", () => {
    expect(sent(load(explained)).detail).toBe('Calls deposit on FlowVault, 1 transaction');
    expect(sent(load(undecoded)).detail).toBe(
      'Calls an unknown function on 0x79bB…D793, 1 transaction',
    );
  });
});
