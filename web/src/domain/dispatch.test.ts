import { describe, expect, it } from 'vitest';

import { parseDetail } from '../console/api/parse';
import { dispatchName, RELAY_DECODER, relayItem, summaryOf } from './dispatch';

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
          call: { target: 'Memo1111', decoded: false, data: '' },
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
      callCount: 1,
      totals: [
        { asset: 'USDC', name: 'USDC', raw: '10000000', decimals: 6 },
        { asset: 'SOL', name: 'SOL', raw: '1000', decimals: 9 },
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

describe("a Relay Dispatch's one transaction as an item", () => {
  const relay = (extra: object) =>
    parseDetail({
      dispatchId: ID,
      mode: 'relay',
      chain: 'base',
      createdAt: '2026-10-31T10:00:00.000Z',
      status: 'confirmed',
      transactionHash: '0xabc',
      error: null,
      ...extra,
    });

  it('is a payment to its target when it moves native value', () => {
    const detail = relay({
      signer: '0xSigner',
      target: '0xVault',
      value: { asset: 'ETH', amount: '1000', decimals: 18 },
    });
    expect(detail).toMatchObject({ signer: '0xSigner', target: '0xVault' });
    expect(detail.mode === 'relay' && relayItem(detail)).toMatchObject({
      type: 'payment',
      recipient: '0xVault',
      amount: { asset: 'ETH', raw: '1000', decimals: 18 },
      status: 'confirmed',
      transactionHash: '0xabc',
    });
  });

  it('is a call to its target when it moves none', () => {
    const detail = relay({ signer: 'Payer', target: 'Memo1111' });
    expect(detail.mode === 'relay' && relayItem(detail)).toMatchObject({
      type: 'call',
      target: 'Memo1111',
      call: { decoder: RELAY_DECODER },
    });
  });

  it('is nothing when the engine did not read the bytes', () => {
    const detail = relay({});
    expect(detail.mode === 'relay' && relayItem(detail)).toBeNull();
  });
});

describe('a Dispatch named by what it carries', () => {
  const managed = { mode: 'managed' as const, totals: [] };

  it('counts payments and calls apart', () => {
    expect(dispatchName({ ...managed, itemCount: 2, callCount: 1 })).toBe('1 payment, 1 call');
    expect(dispatchName({ ...managed, itemCount: 3, callCount: 3 })).toBe('3 calls');
    expect(dispatchName({ ...managed, itemCount: 1200, callCount: 0 })).toBe('1,200 payments');
    expect(dispatchName({ ...managed, itemCount: 5, callCount: 2 })).toBe('3 payments, 2 calls');
  });

  it('falls back to items when the engine does not say how many are calls', () => {
    expect(dispatchName({ ...managed, itemCount: 3 })).toBe('3 items');
  });

  it('names a Relay Dispatch by its mode', () => {
    expect(dispatchName({ mode: 'relay', itemCount: 1, totals: [] })).toBe('Relay transaction');
  });
});
