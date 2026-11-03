import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Console } from '../Console';

const AUTH = 'auth-token-4e1c';
const PAYOUTS = '9wFd3kQe7RzXbN2pLmV8cTyH5sJaG4uWnE1oKiD6mT3a';
const CASPL_MINT = 'DmzLGKjKuYb9Sa2aQ6D7nv51ixj8akwDzujYA8wC1Ne4';

/** A Sender holding SOL, with most of its committed work in a token. */
const payouts = {
  chain: 'solana',
  name: 'payouts',
  default: true,
  network: 'devnet',
  mode: 'single',
  address: PAYOUTS,
  multisig: null,
  balances: [
    {
      holder: 'sender',
      address: PAYOUTS,
      assets: [
        { asset: 'SOL', decimals: 9, balance: '2150448210', committed: '5000' },
        { asset: 'CASPL', decimals: 6, balance: '9000000', committed: '4000000' },
        { asset: 'USDC', decimals: 6, balance: '0', committed: '0' },
      ],
    },
  ],
  signerKey: { status: 'not_read_yet' },
  foreignActivity: null,
};

const known = (fields: Record<string, unknown>) => ({
  chain: 'solana',
  kind: 'spl',
  source: 'config',
  enabled: true,
  addedBy: null,
  addedAt: '2026-10-28T14:02:11.040Z',
  ...fields,
});

const assets = [
  known({
    id: '90f91669-f845-45bf-b44a-d571ac098032',
    address: 'native',
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
    kind: 'native',
  }),
  known({
    id: '1e2d3c4b-5a69-4788-97a6-b5c4d3e2f1a0',
    address: CASPL_MINT,
    symbol: 'CASPL',
    name: 'Case Payroll',
    decimals: 6,
  }),
];

function fetcher(input: string, init: RequestInit = {}) {
  const url = new URL(input, 'http://engine.test');
  const answer = (json: unknown) => Promise.resolve(new Response(JSON.stringify(json)));
  switch (`${init.method ?? 'GET'} ${url.pathname}`) {
    case 'GET /v1/token':
      return answer({ kind: 'auth' });
    case 'GET /v1/senders':
      return answer({ senders: [payouts] });
    case 'GET /v1/assets':
      return answer({ assets });
    case 'GET /v1/setup':
      return answer({ worker: { status: 'not_run_yet' }, checks: [] });
    case 'GET /v1/dispatches':
      return answer({ dispatches: [], nextCursor: null });
    case 'GET /v1/contracts':
      return answer({ contracts: [] });
    default:
      return Promise.resolve(new Response('{}', { status: 404 }));
  }
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/console');
  vi.stubGlobal('fetch', vi.fn(fetcher));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the Overview Senders card (#191)', () => {
  it('headlines the native coin, with each token under it, as the sidebar card does', async () => {
    const user = userEvent.setup();
    render(<Console />);
    await user.type(screen.getByLabelText('Token'), AUTH);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const heading = await screen.findByRole('heading', { name: 'Senders' });
    const card = heading.closest('section')!;
    const item = (await within(card).findByText('payouts')).closest('li')!;

    // The headline line: the name, then the native balance that pays the fees.
    expect(item.firstElementChild!.textContent).toMatch(/^payouts.*2\.1504 .*SOL/);
    expect(item.textContent).toMatch(/0\.000005 committed, 2\.1504 free/);
    // Each token it holds or has work in, under the headline; an empty one is left out.
    const tokens = within(item)
      .getAllByRole('listitem')
      .map((token) => token.textContent);
    expect(tokens).toEqual([expect.stringMatching(/^9 CASPL.*4 committed$/)]);
  });
});
