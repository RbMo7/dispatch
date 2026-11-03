import { describe, expect, it } from 'vitest';

import { parseDetail, parsePage } from '../console/api/parse';
import { clockTime, consoleClock } from './clockTime';
import type { LoadedDispatch } from './dispatch';
import { dispatchFlow } from './dispatchFlow';

// Local times throughout, so the tests read the same in every time zone.
const now = new Date(2026, 10, 3, 9, 0, 0);

describe('clockTime', () => {
  it('keeps the short form for a time today', () => {
    expect(clockTime(new Date(2026, 10, 3, 11, 25, 16), now)).toBe('11:25:16');
  });

  it('gives the date, without seconds, for a time tomorrow', () => {
    expect(clockTime(new Date(2026, 10, 4, 11, 25, 16), now)).toBe('Nov 4, 11:25');
  });

  it('gives the date for a time two days away', () => {
    expect(clockTime(new Date(2026, 10, 5, 11, 25, 16), now)).toBe('Nov 5, 11:25');
  });

  it('gives the date for a time on an earlier day', () => {
    expect(clockTime(new Date(2026, 10, 2, 23, 59, 59), now)).toBe('Nov 2, 23:59');
  });

  it('adds the year for a time in another year', () => {
    expect(clockTime(new Date(2027, 0, 2, 8, 5, 0), now)).toBe('Jan 2, 2027, 08:05');
  });

  it('treats midnight as the start of its own day', () => {
    expect(clockTime(new Date(2026, 10, 3, 0, 0, 0), now)).toBe('00:00:00');
    expect(clockTime(new Date(2026, 10, 4, 0, 0, 0), now)).toBe('Nov 4, 00:00');
  });
});

describe('a Proposal deadline in the flow', () => {
  const ID = '7f3a91c2-0b1e-4c55-9a7e-2d41f0c3b8e6';
  const chainRef = {
    kind: 'squads',
    multisig: 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv',
    proposal: '8xQyR1sT2uV3wX4yZ5a6B7c8D9e1F2g3H4i5J6k7L8m9',
    transactionIndex: 4,
  };
  const iso = (...at: [number, number, number, number, number, number]) =>
    new Date(...at).toISOString();

  /** An awaiting Squads Proposal, created an hour before `now`, through the real parser. */
  function awaiting(deadline: string): LoadedDispatch {
    const createdAt = iso(2026, 10, 3, 8, 0, 0);
    const row = {
      mode: 'managed',
      chain: 'solana',
      status: 'broadcasting',
      createdAt,
      itemCount: 1,
      totals: [{ asset: 'USDC', decimals: 6, amount: '15' }],
    };
    const approval = {
      state: 'awaiting',
      approvals: 1,
      threshold: 2,
      remaining: 1,
      approvers: [],
      deadline,
      expected: { recipients: 1, totals: [{ asset: 'USDC', amount: '15' }] },
      chainRef,
    };
    const page = parsePage({ dispatches: [{ dispatchId: ID, ...row }], nextCursor: null });
    return {
      summary: page.dispatches[0]!,
      detail: parseDetail({
        dispatchId: ID,
        chain: 'solana',
        createdAt,
        mode: 'managed',
        status: 'broadcasting',
        items: [
          {
            type: 'payment',
            recipient: chainRef.multisig,
            asset: 'USDC',
            decimals: 6,
            amount: '15',
            status: 'awaiting_approval',
            transactionHash: null,
            error: null,
            approval,
          },
        ],
        timeline: [
          { at: createdAt, kind: 'created' },
          { at: iso(2026, 10, 3, 8, 0, 1), kind: 'claimed' },
          {
            at: iso(2026, 10, 3, 8, 0, 3),
            kind: 'proposal_created',
            proposalId: 'p-1',
            chainRef,
            items: [0],
          },
          {
            at: null,
            kind: 'proposal_approval',
            proposalId: 'p-1',
            state: 'awaiting',
            approvals: 1,
            threshold: 2,
          },
        ],
      }),
    };
  }

  const deadlineText = (deadline: string) =>
    dispatchFlow(awaiting(deadline), consoleClock(now), 'devnet').stages.find(
      (s) => typeof s.detail === 'string' && s.detail.startsWith('Deadline'),
    )?.detail;

  it('shows only the time for a deadline today', () => {
    expect(deadlineText(iso(2026, 10, 3, 11, 25, 16))).toBe(
      'Deadline 11:25:16, in 2 h 25 min. The engine never approves.',
    );
  });

  it('shows the date for a deadline tomorrow', () => {
    expect(deadlineText(iso(2026, 10, 4, 11, 25, 16))).toBe(
      'Deadline Nov 4, 11:25, in 26 h 25 min. The engine never approves.',
    );
  });

  it('shows the date for a deadline two days away', () => {
    expect(deadlineText(iso(2026, 10, 5, 11, 25, 16))).toBe(
      'Deadline Nov 5, 11:25, in 2 days. The engine never approves.',
    );
  });

  it('dates the stages of a Dispatch from an earlier day', () => {
    const later = new Date(2026, 10, 4, 9, 0, 0);
    const flow = dispatchFlow(awaiting(iso(2026, 10, 5, 8, 0, 0)), consoleClock(later), 'devnet');
    expect(flow.stages.find((s) => s.title === 'Submitted')?.at).toBe('Nov 3, 08:00');
  });
});
