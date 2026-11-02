import { describe, expect, it } from 'vitest';

import { listFilters, readQuery, writeQuery } from './query';

const today = new Date(2026, 10, 1);

describe('the Dispatches URL', () => {
  it('reads every filter, the selection, tab and item filter back from what it wrote', () => {
    const query = readQuery(
      new URLSearchParams(
        'from=2026-10-01&to=2026-10-31&chain=base&sender=payouts&status=partial&mode=managed&q=7f3a&dispatch=7f3a91c2-0b1e-4c55-9a7e-2d41f0c3b8e6&tab=items&items=failed',
      ),
      today,
    );
    expect(query).toEqual({
      range: { from: '2026-10-01', to: '2026-10-31' },
      chain: 'base',
      sender: 'payouts',
      status: 'partial',
      mode: 'managed',
      search: '7f3a',
      selected: '7f3a91c2-0b1e-4c55-9a7e-2d41f0c3b8e6',
      tab: 'items',
      items: 'failed',
    });
    expect(readQuery(writeQuery(query), today)).toEqual(query);
  });

  it('falls back to the last 30 days and no filter for values it does not know', () => {
    const query = readQuery(
      new URLSearchParams('from=yesterday&chain=evm&sender=Pay%20Outs&status=held&tab=logs'),
      today,
    );
    expect(query.range).toEqual({ from: '2026-10-03', to: '2026-11-01' });
    expect([query.chain, query.sender, query.status, query.tab]).toEqual([
      'all',
      null,
      'all',
      'flow',
    ]);
  });

  it('asks the API for whole local days, `to` exclusive at the next midnight', () => {
    const filters = listFilters(
      readQuery(new URLSearchParams('from=2026-10-01&to=2026-10-31'), today),
    );
    expect(filters.from).toEqual(new Date(2026, 9, 1));
    expect(filters.to).toEqual(new Date(2026, 10, 1));
    expect(filters).not.toHaveProperty('status');
    expect(filters).not.toHaveProperty('sender');
  });

  it('asks the API for one Sender by name when the URL names one', () => {
    const query = readQuery(new URLSearchParams('chain=solana&sender=refunds'), today);
    expect(listFilters(query)).toMatchObject({ chain: 'solana', sender: 'refunds' });
  });
});
