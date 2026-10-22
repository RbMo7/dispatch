import { describe, expect, it } from 'vitest';

import { holdsCommitment, sumAssetAmounts, totalCommitted } from './committed.js';

describe('sumAssetAmounts', () => {
  it('totals per asset without losing precision, in first-seen order', () => {
    expect(
      sumAssetAmounts([
        [{ asset: 'USDC', amount: '9007199254740993' }],
        [
          { asset: 'SOL', amount: '5' },
          { asset: 'USDC', amount: '7' },
        ],
      ]),
    ).toEqual([
      { asset: 'USDC', amount: '9007199254741000' },
      { asset: 'SOL', amount: '5' },
    ]);
  });

  it('is empty for nothing', () => {
    expect(sumAssetAmounts([])).toEqual([]);
  });
});

describe('holdsCommitment', () => {
  const since = new Date('2026-10-01T00:00:00Z');

  it('holds while in flight, and for a timed-out Proposal only inside the window', () => {
    for (const phase of ['noted', 'open', 'executing'] as const) {
      expect(holdsCommitment({ phase, timedOutAt: null }, since)).toBe(true);
    }
    expect(holdsCommitment({ phase: 'timed_out', timedOutAt: new Date('2026-10-02') }, since)).toBe(
      true,
    );
    expect(holdsCommitment({ phase: 'timed_out', timedOutAt: new Date('2026-09-30') }, since)).toBe(
      false,
    );
    expect(holdsCommitment({ phase: 'resolved', timedOutAt: null }, since)).toBe(false);
  });
});

describe('totalCommitted', () => {
  const proposals = [
    {
      committed: {
        sender: [{ asset: 'USDC', amount: '30' }],
        proposer: [{ asset: 'SOL', amount: '5' }],
      },
    },
  ];
  const payments = [{ recipient: 'r', asset: 'USDC', amount: '10' }, null];

  it('adds not-yet-proposed payments for the sender only', () => {
    expect(totalCommitted('sender', proposals, payments)).toEqual([
      { asset: 'USDC', amount: '40' },
    ]);
    expect(totalCommitted('proposer', proposals, payments)).toEqual([
      { asset: 'SOL', amount: '5' },
    ]);
  });
});
