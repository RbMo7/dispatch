import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Console } from './Console';

const AUTH = 'auth-token-4e1c';
const OPERATOR = 'operator-token-9b72';
const HELD_ID = '7f3a91c2-5d4e-4b1a-9c2f-0e8d6a4b2a41';
const RULE_ID = 'b3c1e0d2-5f4a-4c8e-9a71-2d6f0e8b9c13';
const PAYOUTS = '9wFd3kQe7RzXbN2pLmV8cTyH5sJaG4uWnE1oKiD6mT3a';
const TREASURY = 'Gx7kP2sV9qWmR4tY8uZ3aB6cD1eF5gH7jK9mN2pQ2rv';
const ALICE = '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe';
const HELD_AT = '2026-11-01T09:12:44.318Z';

const operatorPaths = ['/v1/activity', '/v1/flag-rules', '/release', '/v1/rejected'];

function sender(name: string, address: string, isDefault: boolean) {
  return {
    chain: 'solana',
    name,
    default: isDefault,
    network: 'devnet',
    mode: 'single',
    address,
    multisig: null,
    balances: [
      {
        holder: 'sender',
        address,
        assets: [
          { asset: 'SOL', decimals: 9, balance: '2150448210', committed: '0' },
          { asset: 'USDC', decimals: 6, balance: '18240330000', committed: '0' },
        ],
      },
    ],
    signerKey: { status: 'not_read_yet' },
  };
}

const rule = {
  ruleId: RULE_ID,
  version: 2,
  name: 'Large treasury USDC',
  chain: 'solana',
  sender: { name: 'treasury', address: TREASURY },
  enabled: true,
  kind: 'item_over',
  asset: 'USDC',
  limit: '7500',
  createdAt: '2026-10-28T14:02:11.040Z',
  updatedAt: '2026-10-30T08:47:52.913Z',
  deletedAt: null,
  versions: [
    {
      version: 1,
      name: 'Large treasury USDC',
      chain: 'solana',
      sender: null,
      enabled: true,
      kind: 'item_over',
      asset: 'USDC',
      limit: '5000',
      createdAt: '2026-10-28T14:02:11.040Z',
    },
    {
      version: 2,
      name: 'Large treasury USDC',
      chain: 'solana',
      sender: { name: 'treasury', address: TREASURY },
      enabled: true,
      kind: 'item_over',
      asset: 'USDC',
      limit: '7500',
      createdAt: '2026-10-30T08:47:52.913Z',
    },
  ],
};

/** A fake engine: the routes the console reads, each request recorded with its token. */
function engine() {
  let held = true;
  const requests: { method: string; path: string; token: string; body: unknown }[] = [];
  const payment = (amount: string) => ({
    type: 'payment',
    recipient: ALICE,
    asset: 'USDC',
    decimals: 6,
    amount,
    status: held ? 'held' : 'queued',
    transactionHash: null,
  });
  const detail = () => ({
    dispatchId: HELD_ID,
    mode: 'managed',
    chain: 'solana',
    sender: { name: 'treasury', address: TREASURY },
    createdAt: HELD_AT,
    status: held ? 'held' : 'queued',
    items: [payment('8125400000'), payment('412500000')],
    hold: {
      matched: [
        {
          rule: { name: 'Large treasury USDC', kind: 'item_over', asset: 'USDC', limit: '7500' },
          ruleId: RULE_ID,
          ruleVersion: 2,
          items: [0],
        },
      ],
      heldAt: HELD_AT,
      ...(held ? {} : { releasedAt: '2026-11-01T10:02:00.000Z', reason: 'checked with finance' }),
    },
    timeline: [{ kind: 'created', at: HELD_AT }],
  });
  const summary = () => ({
    dispatchId: HELD_ID,
    mode: 'managed',
    chain: 'solana',
    sender: { name: 'treasury', address: TREASURY },
    status: held ? 'held' : 'queued',
    createdAt: HELD_AT,
    itemCount: 2,
    totals: [{ asset: 'USDC', decimals: 6, amount: '8537900000' }],
  });

  const fetcher = vi.fn((input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://engine.test');
    const method = init.method ?? 'GET';
    const token =
      (init.headers as Record<string, string>).Authorization?.replace('Bearer ', '') ?? '';
    const body: unknown = init.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ method, path: url.pathname, token, body });
    const answer = (status: number, json: unknown) =>
      Promise.resolve(new Response(JSON.stringify(json), { status }));
    const kind = { [AUTH]: 'auth', [OPERATOR]: 'operator' }[token];
    if (!kind) return answer(401, { error: 'unauthorized' });
    if (kind !== 'operator' && operatorPaths.some((p) => url.pathname.includes(p))) {
      return answer(403, { error: 'this route needs OPERATOR_TOKEN, not AUTH_TOKEN' });
    }
    switch (`${method} ${url.pathname}`) {
      case 'GET /v1/token':
        return answer(200, { kind });
      case 'GET /v1/senders':
        return answer(200, {
          senders: [sender('payouts', PAYOUTS, true), sender('treasury', TREASURY, false)],
        });
      case 'GET /v1/setup':
        return answer(200, { worker: { status: 'not_run_yet' }, checks: [] });
      case 'GET /v1/dispatches': {
        const status = url.searchParams.get('status');
        const rows = status === null || status === summary().status ? [summary()] : [];
        return answer(200, { dispatches: rows, nextCursor: null });
      }
      case `GET /v1/dispatch/${HELD_ID}`:
        return answer(200, detail());
      case `POST /v1/dispatch/${HELD_ID}/release`:
        held = false;
        return answer(200, detail());
      case 'GET /v1/flag-rules':
        return answer(200, { rules: [rule] });
      case 'POST /v1/flag-rules/preview':
        return answer(200, {
          from: '2026-10-02T10:00:00.000Z',
          to: '2026-11-01T10:00:00.000Z',
          scanned: 41,
          capped: false,
          wouldHold: 3,
          examples: [{ dispatchId: HELD_ID, createdAt: HELD_AT, items: [0] }],
        });
      case 'GET /v1/activity':
        return answer(200, {
          actions: [
            {
              id: '4a7c2e19-8d3b-4f61-a5e0-7b9c1d2f3e48',
              at: '2026-11-01T10:02:00.000Z',
              action: 'release',
              targetId: HELD_ID,
              tokenKind: 'operator',
              reason: 'checked with finance',
            },
          ],
          nextCursor: null,
        });
      case 'GET /v1/rejected':
        return answer(200, {
          rejected: [
            {
              id: '2c4f7e1a-9b3d-4e58-a6c0-1d8f2b7e4a93',
              at: new Date(Date.now() - 3_600_000).toISOString(),
              status: 400,
              chain: 'base',
              idempotencyKey: 'payroll-2026-11-01-0417',
              tokenKind: 'auth',
              code: 'UNKNOWN_ASSET',
              message: 'no known token configured for asset "USDT"',
              chainDetail: { asset: 'USDT' },
              body: {
                chain: 'base',
                items: [
                  {
                    type: 'payment',
                    recipient: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
                    asset: 'USDT',
                    amount: '25000000',
                  },
                ],
              },
            },
          ],
          nextCursor: null,
          last24Hours: 3,
        });
      default:
        return answer(404, { error: 'Not Found' });
    }
  });
  return { fetcher, requests };
}

async function signIn(token: string, at = '/console') {
  window.history.replaceState(null, '', at);
  const fake = engine();
  vi.stubGlobal('fetch', fake.fetcher);
  const user = userEvent.setup();
  render(<Console />);
  await user.type(screen.getByLabelText('Token'), token);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('navigation', { name: 'Console' });
  return { ...fake, user };
}

const navNames = () =>
  within(screen.getAllByRole('navigation', { name: 'Console' })[0]!)
    .getAllByRole('link')
    .map((link) => link.textContent);

beforeEach(() => {
  sessionStorage.clear();
  // jsdom has no layout; give the items table the height a browser would measure.
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(408);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signing in with AUTH_TOKEN (ADR-0057)', () => {
  it('hides Held, Flag Rules and Activity, and never calls an operator-only route', async () => {
    const { requests, user } = await signIn(AUTH, '/console/held');

    expect(navNames()).toEqual(['Overview', 'Dispatches', 'Senders & Keys', 'Setup']);
    expect(await screen.findByText('Oldest hold')).toBeTruthy();
    await user.click(screen.getAllByRole('link', { name: /Dispatches/ })[0]!);
    await user.click(await screen.findByRole('button', { name: /2 payments/ }));
    await screen.findByRole('button', { name: 'Cancel Dispatch' });

    expect(requests.filter((r) => operatorPaths.some((p) => r.path.includes(p)))).toEqual([]);
    expect(requests.every((r) => r.token === AUTH)).toBe(true);
  });
});

describe('signing in with OPERATOR_TOKEN', () => {
  it('shows the operator pages, with the held count beside Held', async () => {
    await signIn(OPERATOR);

    await waitFor(() =>
      expect(navNames()).toEqual([
        'Overview',
        'Dispatches',
        'Held1',
        'Flag Rules',
        'Senders & Keys',
        'Activity',
        'Rejected',
        'Setup',
      ]),
    );
  });

  it("counts the last day's refused requests under Needs attention, linking to Rejected", async () => {
    await signIn(OPERATOR);

    const entry = await screen.findByText('3 in the last 24 hours, each with what to fix');
    expect(entry.closest('a')?.getAttribute('href')).toBe('/console/rejected');
  });

  it('explains a refused request and links to adding its asset, chain and symbol filled in', async () => {
    const { user } = await signIn(OPERATOR, '/console/rejected');

    expect(await screen.findByText('Unknown asset')).toBeTruthy();
    expect(
      screen.getByText('USDT is not a known asset on Base. Add it under Assets, then send again.'),
    ).toBeTruthy();
    expect(screen.getByText('Base, key payroll-2026-11-01-0417, API token')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add it under Assets ›' }).getAttribute('href')).toBe(
      '/console/assets?chain=base&symbol=USDT',
    );

    await user.click(screen.getByRole('button', { name: 'Show body' }));
    expect(screen.getByLabelText('Request body').textContent).toContain('"asset": "USDT"');
  });

  it('names the rule and tints the item it matched, and releases only with a reason', async () => {
    const { requests, user } = await signIn(OPERATOR, `/console/held?dispatch=${HELD_ID}`);
    const pane = await screen.findByRole('region', { name: 'Held Dispatch detail' });

    await within(pane).findByText('Held by one rule');
    expect(within(pane).getByRole('listitem').textContent).toBe(
      'Large treasury USDCA payment over 7,500 USDCItem 1, version 2',
    );
    const marked = () =>
      within(pane)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.hasAttribute('data-marked'));
    await waitFor(() => expect(marked()).toEqual([true]));
    await user.click(within(pane).getByRole('button', { name: /^All/ }));
    await waitFor(() => expect(marked()).toEqual([true, false]));

    await user.click(within(pane).getByRole('button', { name: 'Release' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release Dispatch' });
    const release = within(dialog).getByRole('button', { name: 'Release' });
    expect((release as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Reason'), '   ');
    expect((release as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Reason'), 'checked with finance');
    await user.click(release);

    await waitFor(() =>
      expect(requests.filter((r) => r.path.endsWith('/release'))).toEqual([
        {
          method: 'POST',
          path: `/v1/dispatch/${HELD_ID}/release`,
          token: OPERATOR,
          body: { reason: 'checked with finance' },
        },
      ]),
    );
    expect(await screen.findByText('Nothing is held.', { exact: false })).toBeTruthy();

    await user.click(screen.getAllByRole('link', { name: /Dispatches/ })[0]!);
    const list = await screen.findByRole('button', { name: /2 payments/ });
    expect(within(list).getByText('Queued')).toBeTruthy();
  });

  it('previews a rule over the last 30 days before anything is saved', async () => {
    const { requests, user } = await signIn(OPERATOR, '/console/rules');

    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    const editor = await screen.findByRole('region', { name: 'Flag Rule editor' });
    expect(within(editor).getByLabelText('Sender')).toBeTruthy();
    await user.type(within(editor).getByLabelText('Limit'), '5000');

    const preview = within(editor).getByRole('region', { name: 'Preview' });
    expect(await within(preview).findByText('3')).toBeTruthy();
    expect(within(preview).getByText('Dispatches of 41 would have been held.')).toBeTruthy();
    const previews = requests.filter((r) => r.path === '/v1/flag-rules/preview');
    expect(previews.at(-1)?.body).toMatchObject({
      chain: 'solana',
      sender: null,
      kind: 'item_over',
      asset: 'SOL',
      limit: '5000',
    });
    expect(requests.some((r) => r.method === 'POST' && r.path === '/v1/flag-rules')).toBe(false);
  });

  it('lists the activity record under its day, with the reason and the token', async () => {
    await signIn(OPERATOR, '/console/activity');

    expect(await screen.findByText('Released')).toBeTruthy();
    expect(screen.getByText('checked with finance')).toBeTruthy();
    expect(screen.getByText('Operator token')).toBeTruthy();
  });
});
