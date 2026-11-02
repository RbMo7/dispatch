import { describe, expect, it } from 'vitest';

import { parseDetail, parsePage } from '../console/api/parse';
import type { LoadedDispatch } from './dispatch';
import { dispatchFlow, gwei } from './dispatchFlow';
import type { Flow, Stage } from './flow';

/** The flows the baseline run found short (#168): holds, Bulk Calls and partial Dispatches. */

const clock = {
  now: new Date('2026-11-02T11:00:00Z'),
  time: (at: Date) => at.toISOString().slice(11, 19),
};
const ID = '7f3a91c2-0b1e-4c55-9a7e-2d41f0c3b8e6';
const ALICE = '0x4c1e2f0a9b7d3e5c8a6f1b2d4e9c0a7f3b5d9a07';
const H_AA = '0xaa1f5e0c3b2d7a9e4f6c8b1d0e2a3f5c7b9d1e3f5a7c9e1b3d5f7a9c1e3b5d7f';
const H_BB = '0xbb4c2d9e7f1a3b5c8d0e2f4a6b8c1d3e5f7a9b2c4d6e8f0a1b3c5d7e9f2a4b6c';
const CREATED = '2026-11-02T10:00:00.000Z';

function load(status: string, body: object): LoadedDispatch {
  const page = parsePage({
    dispatches: [
      {
        dispatchId: ID,
        mode: 'managed',
        chain: 'base',
        status,
        createdAt: CREATED,
        itemCount: 2,
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
      createdAt: CREATED,
      status,
      ...body,
    }),
  };
}

const payment = (extra: object) => ({
  type: 'payment',
  recipient: ALICE,
  asset: 'USDC',
  decimals: 6,
  amount: '9000000000',
  transactionHash: null,
  error: null,
  ...extra,
});

const hold = (extra: object = {}) => ({
  matched: [
    {
      rule: { name: 'Big USDC', kind: 'item_over', asset: 'USDC', limit: '5000' },
      ruleId: '0b7c5a52-1f0e-4a4d-8c3b-6f5e4d3c2b1a',
      ruleVersion: 1,
      items: [0],
    },
  ],
  heldAt: CREATED,
  ...extra,
});

const titled = (flow: Flow, title: string): Stage => flow.stages.find((s) => s.title === title)!;
const titles = (flow: Flow) => flow.stages.map((s) => `${s.kind} ${s.title}`);
const WHY = 'Rule "Big USDC" matched item 1: a payment over 5,000 USDC.';

describe('a held Dispatch in the flow', () => {
  it('names the rule, its limit and the items it matched while held', () => {
    const flow = dispatchFlow(
      load('held', {
        items: [payment({ status: 'held' }), payment({ amount: '1', status: 'held' })],
        hold: hold(),
        timeline: [{ kind: 'created', at: CREATED }],
      }),
      clock,
      'base-sepolia',
    );
    expect(titled(flow, 'Held')).toMatchObject({
      kind: 'current',
      at: '10:00:00',
      detail: `${WHY} Nothing is signed until an operator releases it.`,
    });
  });

  it('keeps the Held stage after a release, with who released it, when and why', () => {
    const flow = dispatchFlow(
      load('confirmed', {
        items: [
          payment({ status: 'confirmed', transactionHash: H_AA }),
          payment({ amount: '1', status: 'confirmed', transactionHash: H_BB }),
        ],
        hold: hold({ releasedAt: '2026-11-02T10:05:00.000Z', reason: 'checked with finance' }),
        timeline: [
          { kind: 'created', at: CREATED },
          { kind: 'claimed', at: '2026-11-02T10:05:01.000Z' },
          {
            kind: 'written',
            at: '2026-11-02T10:05:02.000Z',
            hash: H_AA,
            items: [0],
            replaces: null,
          },
          {
            kind: 'written',
            at: '2026-11-02T10:05:02.000Z',
            hash: H_BB,
            items: [1],
            replaces: null,
          },
          { kind: 'confirmed', at: '2026-11-02T10:05:10.000Z', hash: H_AA, items: [0] },
          { kind: 'confirmed', at: '2026-11-02T10:05:10.000Z', hash: H_BB, items: [1] },
        ],
      }),
      clock,
      'base-sepolia',
    );
    expect(titles(flow).slice(0, 3)).toEqual(['done Submitted', 'done Held', 'done Claimed']);
    expect(titled(flow, 'Held').detail).toBe(
      `${WHY} Released with the operator token at 10:05:00, after 5 min: checked with finance.`,
    );
  });

  it('shows the hold and the cancel reason on a held Dispatch that was cancelled', () => {
    const flow = dispatchFlow(
      load('cancelled', {
        items: [payment({ status: 'cancelled' }), payment({ amount: '1', status: 'cancelled' })],
        hold: hold(),
        cancellation: {
          at: '2026-11-02T10:07:00.000Z',
          tokenKind: 'operator',
          reason: 'duplicate',
        },
        timeline: [
          { kind: 'created', at: CREATED },
          { kind: 'cancelled', at: '2026-11-02T10:07:00.000Z' },
        ],
      }),
      clock,
      'base-sepolia',
    );
    expect(titles(flow)).toEqual(['done Submitted', 'done Held', 'end-cancelled Cancelled']);
    expect(titled(flow, 'Held').detail).toBe(
      `${WHY} Cancelled while held, so it was never released.`,
    );
    expect(titled(flow, 'Cancelled').detail).toContain(
      'Cancelled with the operator token: duplicate.',
    );
  });
});

describe('a Bulk Call in the flow', () => {
  it('names the aggregator and allowFailure on the send stage', () => {
    const flow = dispatchFlow(
      load('confirmed', {
        retryPolicy: false,
        bulkCall: {
          aggregator: '0x5a1f00000000000000000000000000000000009c',
          label: 'FlowAggregator',
          maxBatchSize: 50,
          allowFailure: false,
        },
        items: [
          payment({ status: 'confirmed', transactionHash: H_AA }),
          payment({ amount: '1', status: 'confirmed', transactionHash: H_AA }),
        ],
        timeline: [
          { kind: 'created', at: CREATED },
          { kind: 'claimed', at: '2026-11-02T10:00:01.000Z' },
          {
            kind: 'written',
            at: '2026-11-02T10:00:02.000Z',
            hash: H_AA,
            items: [0, 1],
            replaces: null,
          },
          { kind: 'confirmed', at: '2026-11-02T10:00:10.000Z', hash: H_AA, items: [0, 1] },
        ],
      }),
      clock,
      'base-sepolia',
    );
    expect(titled(flow, 'Sent as a Bulk Call').detail).toBe(
      'Through the aggregator FlowAggregator (0x5a1f…009c), allowFailure false, 1 transaction carries 2 items',
    );
  });
});

describe('a partial Dispatch in the flow', () => {
  it('lists every transaction hash it sent, each with how it ended', () => {
    const flow = dispatchFlow(
      load('partial', {
        items: [
          payment({ status: 'confirmed', transactionHash: H_AA }),
          payment({
            amount: '1',
            status: 'failed',
            transactionHash: H_BB,
            error: {
              code: 'CHAIN_REJECTED',
              message: 'reverted',
              chainDetail: { reason: 'FlowVault: always reverts' },
            },
          }),
        ],
        timeline: [
          { kind: 'created', at: CREATED },
          { kind: 'claimed', at: '2026-11-02T10:00:01.000Z' },
          {
            kind: 'written',
            at: '2026-11-02T10:00:02.000Z',
            hash: H_AA,
            items: [0],
            replaces: null,
          },
          {
            kind: 'written',
            at: '2026-11-02T10:00:02.000Z',
            hash: H_BB,
            items: [1],
            replaces: null,
          },
          { kind: 'confirmed', at: '2026-11-02T10:00:10.000Z', hash: H_AA, items: [0] },
          {
            kind: 'failed',
            at: '2026-11-02T10:00:10.000Z',
            hash: H_BB,
            items: [1],
            error: { code: 'CHAIN_REJECTED', message: 'reverted' },
          },
        ],
      }),
      clock,
      'base-sepolia',
    );
    const end = flow.stages.at(-1)!;
    expect(end).toMatchObject({ kind: 'end-done', title: '2 transaction hashes' });
    expect(end.hashes?.map((h) => [h.hash, h.outcome, h.failed])).toEqual([
      [H_AA, 'Confirmed', false],
      [H_BB, 'Failed', true],
    ]);
    expect(end.hashes?.[1]?.links[0]?.label).toBe('View on Basescan');
  });
});

describe('gwei', () => {
  it('keeps four significant digits, so a small Base fee does not read as zero', () => {
    expect(gwei('1500000000')).toBe('1.5');
    expect(gwei('12345678')).toBe('0.01235');
    expect(gwei('0')).toBe('0');
  });
});
