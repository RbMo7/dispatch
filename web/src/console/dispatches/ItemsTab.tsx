import { CaretDown, CaretRight, DownloadSimple } from '@phosphor-icons/react';
import { type ReactNode, useMemo, useState } from 'react';

import { Amount } from '../../components/Amount';
import { Menu } from '../../components/Menu';
import { MonoValue } from '../../components/MonoValue';
import { SearchField } from '../../components/SearchField';
import { StatusPill } from '../../components/StatusPill';
import { type Column, VirtualTable } from '../../components/VirtualTable';
import { type Item, type ItemFilter, itemTarget } from '../../domain/dispatch';
import { STATUSES } from '../../domain/status';
import { EXPORT_FORMATS, type ExportFormat } from '../../export/download';
import styles from '../console.module.css';
import { filterItems, type ItemRow, itemRows, paidIn, statusCounts } from './itemRows';

const count = new Intl.NumberFormat('en-US');

const COLUMNS: readonly Column<ItemRow>[] = [
  {
    id: 'index',
    header: '#',
    width: '32px',
    render: (row) =>
      row.kind === 'item' && <span className={styles.muted}>{row.item.index + 1}</span>,
  },
  {
    id: 'target',
    header: 'Recipient',
    width: 'minmax(0, 1fr)',
    render: (row) =>
      row.kind === 'item' && <MonoValue value={itemTarget(row.item)} head={5} tail={4} />,
  },
  {
    id: 'amount',
    header: 'Amount',
    width: '100px',
    align: 'end',
    render: (row) => {
      if (row.kind !== 'item' || row.item.type !== 'payment') return null;
      return row.item.amount ? (
        <Amount {...row.item.amount} />
      ) : (
        <span className={styles.muted}>{row.item.asset}</span>
      );
    },
  },
  {
    id: 'status',
    header: 'Status',
    width: '104px',
    render: (row) => row.kind === 'item' && <StatusPill status={row.item.status} />,
  },
  {
    id: 'hash',
    header: 'Hash',
    width: '64px',
    render: (row) => {
      if (row.kind !== 'item') return null;
      if (row.bundled) return <span className={styles.muted}>Bundled</span>;
      return row.item.transactionHash ? (
        <MonoValue value={row.item.transactionHash} head={4} tail={3} />
      ) : (
        <span className={styles.muted}>None</span>
      );
    },
  },
];

interface ItemsTabProps {
  items: readonly Item[];
  filter: ItemFilter;
  onFilter: (filter: ItemFilter) => void;
  search: string;
  onSearch: (search: string) => void;
  /** Exports what the table shows: the current filter and search. */
  onExport: (format: ExportFormat, items: readonly Item[]) => void;
  /** The Proposals these items sit in, with their Approvers. */
  approvals?: ReactNode;
}

export function ItemsTab({
  items,
  filter,
  onFilter,
  search,
  onSearch,
  onExport,
  approvals,
}: ItemsTabProps) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const counts = useMemo(() => statusCounts(items), [items]);
  const shown = useMemo(() => filterItems(items, filter, search), [items, filter, search]);
  const rows = useMemo(() => itemRows(shown, toggled), [shown, toggled]);
  const assets = useMemo(() => paidIn(items), [items]);

  const chips: { id: ItemFilter; label: string; n: number }[] = [
    { id: 'all', label: 'All', n: items.length },
    ...counts.map(({ status, n }) => ({ id: status, label: STATUSES[status].label, n })),
  ];

  const toggle = (hash: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(hash)) next.add(hash);
      return next;
    });

  return (
    <div className={styles.items}>
      {approvals && <div className={styles.paneApprovals}>{approvals}</div>}
      <div className={styles.chips} role="group" aria-label="Filter items by status">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={styles.chip}
            aria-pressed={filter === chip.id}
            onClick={() => onFilter(chip.id)}
          >
            {chip.label}
            <span className={styles.chipCount}>{count.format(chip.n)}</span>
          </button>
        ))}
      </div>
      {assets && <p className={styles.paidIn}>Paid in {assets}</p>}
      <div className={styles.itemsBar}>
        <SearchField
          label="Search items"
          placeholder="Recipient, target or hash"
          value={search}
          onChange={onSearch}
          width={280}
        />
        <Menu
          label="Export"
          icon={<DownloadSimple size={14} aria-hidden="true" />}
          disabled={shown.length === 0}
          items={EXPORT_FORMATS.map((format) => ({
            id: format.id,
            label: format.label,
            onSelect: () => onExport(format.id, shown),
          }))}
        />
      </div>
      <VirtualTable
        label={`Items, ${count.format(shown.length)} shown`}
        rows={rows}
        columns={COLUMNS}
        rowKey={(row) => (row.kind === 'bundle' ? `bundle-${row.hash}` : row.item.index)}
        span={(row) =>
          row.kind === 'bundle' ? (
            <button
              type="button"
              className={styles.bundle}
              aria-expanded={row.expanded}
              onClick={() => toggle(row.hash)}
            >
              {row.expanded ? (
                <CaretDown size={12} aria-hidden="true" />
              ) : (
                <CaretRight size={12} aria-hidden="true" />
              )}
              <span className={styles.bundleLabel}>
                {count.format(row.count)} items in one transaction
              </span>
              <span className={styles.bundleHash}>{row.hash}</span>
            </button>
          ) : null
        }
        empty={<p className={styles.noRows}>No items match.</p>}
      />
    </div>
  );
}
