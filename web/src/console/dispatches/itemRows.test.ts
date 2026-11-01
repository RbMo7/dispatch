import { describe, expect, it } from 'vitest';

import type { Item } from '../../domain/dispatch';
import { filterItems, itemRows, statusCounts } from './itemRows';

function item(index: number, hash: string | null, status: Item['status'] = 'confirmed'): Item {
  return {
    index,
    type: 'payment',
    recipient: `9wFd3kQe7RzXbN2pLmV8cTyH5sJaG4uWnE1oKiD6m${String(index).padStart(3, '0')}`,
    asset: 'USDC',
    amount: { raw: '1500000', decimals: 6, asset: 'USDC', name: 'USD Coin' },
    status,
    transactionHash: hash,
    error: null,
    approval: null,
  };
}

const shape = (rows: ReturnType<typeof itemRows>) =>
  rows.map((row) =>
    row.kind === 'bundle'
      ? `bundle ${row.hash} x${row.count}${row.expanded ? '' : ' collapsed'}`
      : row.kind === 'error'
        ? `  why #${row.item.index}`
        : `${row.bundled ? '  ' : ''}#${row.item.index}`,
  );

describe('the Items table rows', () => {
  it('groups items sharing a transaction under it, in request order', () => {
    const items = [item(0, 'a'), item(1, 'b'), item(2, 'a'), item(3, null, 'queued'), item(4, 'c')];
    expect(shape(itemRows(items, new Set()))).toEqual([
      'bundle a x2',
      '  #0',
      '  #2',
      '#1',
      '#3',
      '#4',
    ]);
  });

  it('collapses a bundle over 20 items until it is toggled open', () => {
    const items = Array.from({ length: 21 }, (_, i) => item(i, 'big'));
    expect(shape(itemRows(items, new Set()))).toEqual(['bundle big x21 collapsed']);
    expect(itemRows(items, new Set(['big']))).toHaveLength(22);
  });

  it('follows an item that has an error with a row saying why, bundled or not', () => {
    const reverted = { code: 'CHAIN_REJECTED', message: 'reverted: always reverts' };
    const items = [
      item(0, 'a'),
      { ...item(1, 'b', 'failed'), error: reverted },
      { ...item(2, 'c', 'failed'), error: reverted },
      { ...item(3, 'c', 'failed'), error: reverted },
    ];
    expect(shape(itemRows(items, new Set()))).toEqual([
      '#0',
      '#1',
      '  why #1',
      'bundle c x2',
      '  #2',
      '  why #2',
      '  #3',
      '  why #3',
    ]);
  });

  it('counts statuses for the chips and filters by status and search together', () => {
    const items = [item(0, 'a'), item(1, null, 'failed'), item(2, 'b2c4', 'failed')];
    expect(statusCounts(items)).toEqual([
      { status: 'confirmed', n: 1 },
      { status: 'failed', n: 2 },
    ]);
    expect(filterItems(items, 'failed', 'B2C').map((i) => i.index)).toEqual([2]);
    expect(filterItems(items, 'all', 'm001').map((i) => i.index)).toEqual([1]);
  });
});
