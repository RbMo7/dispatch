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

const USDC = { raw: '1842300000', decimals: 6, asset: 'USDC' };

describe('hidden balances', () => {
  it('masks every amount but keeps the unit, and remembers the choice', async () => {
    const user = userEvent.setup();
    const view = () =>
      render(
        <BalancesProvider>
          <EyeToggle />
          <Amount {...USDC} />
        </BalancesProvider>,
      );
    view();
    expect(screen.getByLabelText('1,842.30 USDC')).toBeTruthy();

    const eye = screen.getByRole('button', { name: 'Hide balances' });
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    await user.click(eye);

    const hidden = screen.getByLabelText('Hidden USDC amount');
    expect(hidden.textContent).toBe('••••USDC');
    expect(screen.getByRole('button', { name: 'Show balances' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    cleanup();
    view();
    expect(screen.getByLabelText('Hidden USDC amount')).toBeTruthy();
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

  it('runs a stage link that opens another view', async () => {
    const onSelect = vi.fn();
    render(
      <FlowGraph
        flow={{
          ...flow,
          stages: [
            {
              kind: 'branch-failed',
              title: 'Item failures, 3',
              links: [{ label: 'Show in Items', onSelect }],
            },
          ],
        }}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show in Items ›' }));
    expect(onSelect).toHaveBeenCalledOnce();
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
