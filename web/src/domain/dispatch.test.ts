import { describe, expect, it } from 'vitest';

import { parseDetail } from '../console/api/parse';
import { summaryOf } from './dispatch';

const ID = '7f3a91c2-0b1e-4c55-9a7e-2d41f0c3b8e6';
const payment = (asset: string, amount: string, decimals?: number) => ({
  type: 'payment',
  recipient: 'Recipient111',
  asset,
  amount,
  ...(decimals === undefined ? {} : { decimals }),
  status: 'queued',
  transactionHash: null,
  error: null,
});

describe('a Dispatch row from its detail alone', () => {
  it('takes chain, Sender and creation time from the detail and sums each asset its payments carry', () => {
    const detail = parseDetail({
      dispatchId: ID,
      mode: 'managed',
      chain: 'solana',
      sender: { name: 'refunds', address: 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv' },
      createdAt: '2026-10-31T10:00:00.000Z',
      status: 'queued',
      items: [
        payment('USDC', '2500000', 6),
        payment('USDC', '7500000', 6),
        payment('SOL', '1000', 9),
        payment('OLD', '5'),
        {
          type: 'call',
          programId: 'Memo1111',
          status: 'queued',
          transactionHash: null,
          error: null,
        },
      ],
    });

    expect(summaryOf(detail)).toEqual({
      id: ID,
      mode: 'managed',
      chain: 'solana',
      sender: { name: 'refunds', address: 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv' },
      status: 'queued',
      createdAt: new Date('2026-10-31T10:00:00.000Z'),
      itemCount: 5,
      totals: [
        { asset: 'USDC', raw: '10000000', decimals: 6 },
        { asset: 'SOL', raw: '1000', decimals: 9 },
      ],
    });
  });

  it('reads a Relay Dispatch as one item with no totals', () => {
    const detail = parseDetail({
      dispatchId: ID,
      mode: 'relay',
      chain: 'base',
      createdAt: '2026-10-31T10:00:00.000Z',
      status: 'confirmed',
      transactionHash: '0xabc',
      error: null,
    });

    expect(summaryOf(detail)).toMatchObject({
      chain: 'base',
      sender: null,
      itemCount: 1,
      totals: [],
    });
  });
});
