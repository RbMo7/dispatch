import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BalancesProvider } from '../balances';
import { describeRange, presetOf, presetRange } from '../domain/dateRange';
import type { Flow } from '../domain/flow';
import { ALL_STATUSES } from '../domain/status';
import { Amount } from './Amount';
import { DateRangeControl } from './DateRangeControl';
import { EyeToggle } from './EyeToggle';
import { FlowGraph } from './FlowGraph';
import { Menu } from './Menu';
import { SegmentedControl } from './SegmentedControl';
import { VirtualTable } from './VirtualTable';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const USDC = { raw: '1842300000', decimals: 6, asset: 'USDC', name: 'USD Coin' };

describe('hidden balances', () => {
  it('masks every amount but keeps the unit, and remembers the choice', async () => {
    const user = userEvent.setup();
    const view = () =>
      render(
        <BalancesProvider>
          <EyeToggle />
          <p data-testid="amount">
            <Amount {...USDC} />
          </p>
        </BalancesProvider>,
      );
    view();
    const amount = () => screen.getByTestId('amount');
    expect(amount().textContent).toContain('1,842.30');

    const eye = screen.getByRole('button', { name: 'Hide balances' });
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    await user.click(eye);

    expect(amount().textContent).not.toContain('1,842.30');
    expect(amount().textContent).toContain('Hidden amount••••USDC');
    expect(screen.getByRole('button', { name: 'Show balances' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    cleanup();
    view();
    expect(amount().textContent).toContain('Hidden amount••••USDC');
  });
});

describe('the asset name on an amount', () => {
  it('names the asset in a tooltip a keyboard can reach, and Escape hides it', async () => {
    const user = userEvent.setup();
    render(
      <BalancesProvider>
        <Amount {...USDC} />
      </BalancesProvider>,
    );
    expect(screen.queryByText('USD Coin', { selector: '[aria-hidden]' })).toBeNull();

    await user.tab();
    const symbol = screen.getByText('USDC');
    expect(document.activeElement).toBe(symbol);
    expect(symbol.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(symbol.getAttribute('aria-describedby')!)!.textContent).toBe(
      'USD Coin',
    );
    expect(screen.getByText('USD Coin', { selector: '[aria-hidden]' })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByText('USD Coin', { selector: '[aria-hidden]' })).toBeNull();
  });

  it('shows the name on hover', async () => {
    const user = userEvent.setup();
    render(
      <BalancesProvider>
        <Amount {...USDC} variant="plain" unit />
      </BalancesProvider>,
    );
    await user.hover(screen.getByText('USDC'));
    expect(screen.getByText('USD Coin', { selector: '[aria-hidden]' })).toBeTruthy();
  });

  it('adds no tooltip when the name is only the symbol', () => {
    render(
      <BalancesProvider>
        <Amount {...USDC} name="USDC" />
      </BalancesProvider>,
    );
    expect(screen.getByText('USDC').getAttribute('tabindex')).toBeNull();
  });
});

describe('FlowGraph', () => {
  const flow: Flow = {
    summary: '13 of 14 confirmed',
    elapsed: 'Finished at 17:59:31',
    stages: [
      { kind: 'done', title: 'Submitted', at: '17:58:09' },
      { kind: 'branch-failed', title: 'Item 9 failed', detail: 'INVALID_RECIPIENT' },
      { kind: 'current', title: 'Confirmed', count: { reached: 612, of: 1000 } },
      { kind: 'end-todo', title: 'Transaction hash', detail: 'Appears after execution' },
    ],
  };

  it('says each stage state in words, in order', () => {
    render(<FlowGraph flow={flow} />);
    const stages = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(stages[0]).toMatch(/^Done: Submitted17:58:09/);
    expect(stages[1]).toMatch(/^Failed: Item 9 failed/);
    expect(stages[2]).toMatch(/^In progress: Confirmed612 of 1,000/);
    expect(stages[3]).toMatch(/^Not reached yet: Transaction hash/);
  });

  it('gives the stage bar one segment per trunk stage, none for a branch', () => {
    const { container } = render(<FlowGraph flow={flow} />);
    const segments = [...container.querySelectorAll('[data-segment]')].map((s) =>
      s.getAttribute('data-segment'),
    );
    expect(segments).toEqual(['done', 'current', 'todo']);
  });

  it('opens the Items tab with the filter a stage link names', async () => {
    const onShowItems = vi.fn();
    render(
      <FlowGraph
        onShowItems={onShowItems}
        flow={{
          ...flow,
          stages: [
            {
              kind: 'branch-failed',
              title: 'Item failures, 3',
              links: [{ label: 'Show in Items', items: 'failed' }],
            },
          ],
        }}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show in Items ›' }));
    expect(onShowItems).toHaveBeenCalledOnce();
    expect(onShowItems).toHaveBeenCalledWith('failed');
  });
});

describe('date ranges', () => {
  const today = new Date(2026, 9, 31);

  it('counts presets back from today, inclusive', () => {
    expect(presetRange('today', today)).toEqual({ from: '2026-10-31', to: '2026-10-31' });
    expect(presetRange('7d', today)).toEqual({ from: '2026-10-25', to: '2026-10-31' });
    expect(presetRange('30d', today)).toEqual({ from: '2026-10-02', to: '2026-10-31' });
    expect(presetOf({ from: '2026-10-04', to: '2026-10-17' }, today)).toBe('custom');
    expect(describeRange({ from: '2026-10-04', to: '2026-10-17' })).toBe('Oct 4 to Oct 17');
  });

  it('emits { from, to } for a preset and opens a two-month calendar for Custom', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateRangeControl value={presetRange('7d', today)} onChange={onChange} today={today} />);

    await user.click(screen.getByRole('radio', { name: '30 days' }));
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-02', to: '2026-10-31' });

    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose a date range' });
    expect(within(dialog).getAllByRole('grid')).toHaveLength(2);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SegmentedControl', () => {
  it('moves the choice with the arrow keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const options = [
      { value: 'all', label: 'All' },
      { value: 'solana', label: 'Solana' },
      { value: 'base', label: 'Base' },
    ] as const;
    render(<SegmentedControl label="Chain" options={options} value="base" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Base' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('all');
  });
});

describe('Menu', () => {
  it('opens from the keyboard, moves with arrows and runs the chosen item', async () => {
    const user = userEvent.setup();
    const csv = vi.fn();
    const xlsx = vi.fn();
    render(
      <Menu
        label="Export"
        items={[
          { id: 'csv', label: 'CSV', onSelect: csv },
          { id: 'xlsx', label: 'Excel (.xlsx)', onSelect: xlsx },
        ]}
      />,
    );
    screen.getByRole('button', { name: 'Export' }).focus();
    await user.keyboard('{ArrowDown}');
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('CSV'));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(xlsx).toHaveBeenCalledOnce();
    expect(csv).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('VirtualTable', () => {
  it('puts only the visible rows of a thousand in the DOM', () => {
    // jsdom has no layout; give every element the 320 px a browser would measure.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(408);
    const rows = Array.from({ length: 1000 }, (_, i) => ({ i }));
    render(
      <VirtualTable
        label="Items"
        rows={rows}
        columns={[{ id: 'i', header: '#', width: '40px', render: (row) => row.i }]}
        rowKey={(row) => row.i}
        height={320}
      />,
    );
    const table = screen.getByRole('table', { name: 'Items' });
    expect(table.getAttribute('aria-rowcount')).toBe('1001');
    const rendered = within(table).getAllByRole('row').length - 1;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(40);
    vi.restoreAllMocks();
  });
});

describe('status tokens', () => {
  it('defines a pill colour pair in tokens.css for every status', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8');
    for (const status of ALL_STATUSES) {
      expect(css).toContain(`--pill-${status}-fg:`);
      expect(css).toContain(`--pill-${status}-bg:`);
    }
  });
});
