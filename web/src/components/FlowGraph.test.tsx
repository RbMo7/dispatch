import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BalancesProvider } from '../balances';
import { parseDetail, parsePage } from '../console/api/parse';
import { dispatchFlow } from '../domain/dispatchFlow';
import { FlowGraph } from './FlowGraph';

const ID = '7f3a91c2-0b1e-4c55-9a7e-2d41f0c3b8e6';
const H_AA = '0xaa1f5e0c3b2d7a9e4f6c8b1d0e2a3f5c7b9d1e3f5a7c9e1b3d5f7a9c1e3b5d7f';
const H_BB = '0xbb4c2d9e7f1a3b5c8d0e2f4a6b8c1d3e5f7a9b2c4d6e8f0a1b3c5d7e9f2a4b6c';

/** docs/openapi.yaml's fee-bump timeline, as the engine sends it. */
const loaded = {
  summary: parsePage({
    dispatches: [
      {
        dispatchId: ID,
        mode: 'managed',
        chain: 'base',
        status: 'confirmed',
        createdAt: '2026-10-31T10:00:00.000Z',
        itemCount: 1,
        totals: [{ asset: 'USDC', decimals: 6, amount: '12480000000' }],
      },
    ],
    nextCursor: null,
  }).dispatches[0]!,
  detail: parseDetail({
    dispatchId: ID,
    mode: 'managed',
    chain: 'base',
    createdAt: '2026-10-31T10:00:00.000Z',
    status: 'confirmed',
    items: [
      {
        type: 'payment',
        recipient: '0x4c1e2f0a9b7d3e5c8a6f1b2d4e9c0a7f3b5d9a07',
        asset: 'USDC',
        decimals: 6,
        amount: '12480000000',
        status: 'confirmed',
        transactionHash: H_BB,
        error: null,
      },
    ],
    timeline: [
      { at: '2026-10-31T10:00:00.000Z', kind: 'created' },
      { at: '2026-10-31T10:00:01.200Z', kind: 'claimed' },
      { at: '2026-10-31T10:00:01.900Z', kind: 'written', hash: H_AA, items: [0], replaces: null },
      { at: '2026-10-31T10:02:03.000Z', kind: 'written', hash: H_BB, items: [0], replaces: H_AA },
      { at: '2026-10-31T10:02:03.000Z', kind: 'replaced', hash: H_AA, items: [0], by: H_BB },
      { at: '2026-10-31T10:02:20.000Z', kind: 'confirmed', hash: H_BB, items: [0] },
      { at: '2026-10-31T10:02:20.000Z', kind: 'dropped', hash: H_AA, items: [0], by: H_BB },
    ],
  }),
};

const flow = dispatchFlow(
  loaded,
  { now: new Date('2026-10-31T11:00:00Z'), time: (at) => at.toISOString().slice(11, 19) },
  'base',
);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the Flow tab from an engine response', () => {
  it('draws the fee bump as a branch off the main line and ends at the hash that landed', () => {
    const { container } = render(<FlowGraph flow={flow} />);
    const nodes = [...container.querySelectorAll('li')];
    expect(nodes.map((node) => node.dataset.branch ?? 'main')).toEqual([
      'main',
      'main',
      'main',
      'done',
      'main',
      'main',
    ]);
    const end = nodes.at(-1)!;
    expect(within(end).getByRole('button', { name: `Copy ${H_BB}` })).toBeTruthy();
    expect(within(end).getByRole('link', { name: 'View on Basescan ›' }).getAttribute('href')).toBe(
      `https://basescan.org/tx/${H_BB}`,
    );
  });

  it('masks an amount inside stage text when balances are hidden', () => {
    localStorage.setItem('dispatch-hide-balances', '1');
    render(
      <BalancesProvider>
        <FlowGraph flow={flow} />
      </BalancesProvider>,
    );
    const submitted = screen.getByText('Submitted').closest('li')!;
    expect(submitted.textContent).toContain('1 payment, Hidden amount•••• USDC');
    expect(submitted.textContent).not.toContain('12,480.00');
  });
});
