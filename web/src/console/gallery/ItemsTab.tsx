import { DownloadSimple } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { Amount } from '../../components/Amount';
import { Menu } from '../../components/Menu';
import { MonoValue } from '../../components/MonoValue';
import { SearchField } from '../../components/SearchField';
import { StatusPill } from '../../components/StatusPill';
import { type Column, VirtualTable } from '../../components/VirtualTable';
import { type Item, type ItemStatus, itemTarget } from '../../domain/dispatch';
import { ALL_STATUSES, STATUSES } from '../../domain/status';
import { EXPORT_FORMATS, type ExportFormat } from '../../export/download';
import styles from './Gallery.module.css';

export type ItemFilter = 'all' | ItemStatus;

const count = new Intl.NumberFormat('en-US');

const COLUMNS: readonly Column<Item>[] = [
  { id: 'index', header: '#', width: '30px', render: (item) => <span className={styles.muted}>{item.index + 1}</span> },
  {
    id: 'target',
    header: 'Recipient',
    width: 'minmax(0, 1fr)',
    render: (item) => <MonoValue value={itemTarget(item)} head={5} tail={4} />,
  },
  {
    id: 'amount',
    header: 'Amount',
    width: '108px',
    align: 'end',
    render: (item) => (item.amount ? <Amount {...item.amount} /> : null),
  },
  { id: 'status', header: 'Status', width: '104px', render: (item) => <StatusPill status={item.status} /> },
  {
    id: 'hash',
    header: 'Hash',
    width: '62px',
    render: (item) =>
      item.transactionHash ? (
        <MonoValue value={item.transactionHash} head={4} tail={3} />
      ) : (
        <span className={styles.muted}>None</span>
      ),
  },
];

interface ItemsTabProps {
  items: readonly Item[];
  filter: ItemFilter;
  onFilter: (filter: ItemFilter) => void;
  search: string;
  onSearch: (search: string) => void;
  onExport: (format: ExportFormat, rows: readonly Item[]) => void;
}

export function ItemsTab({ items, filter, onFilter, search, onSearch, onExport }: ItemsTabProps) {
  const counts = useMemo(() => {
    const tally = new Map<ItemStatus, number>();
    for (const item of items) tally.set(item.status, (tally.get(item.status) ?? 0) + 1);
    return ALL_STATUSES.flatMap((status) => {
      const n = tally.get(status as ItemStatus);
      return n ? [{ status: status as ItemStatus, n }] : [];
    });
  }, [items]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter(
      (item) =>
        (filter === 'all' || item.status === filter) &&
        (!needle ||
          itemTarget(item).toLowerCase().includes(needle) ||
          (item.transactionHash?.toLowerCase().includes(needle) ?? false)),
    );
  }, [items, filter, search]);

  const chips: { id: ItemFilter; label: string; n: number }[] = [
    { id: 'all', label: 'All', n: items.length },
    ...counts.map(({ status, n }) => ({ id: status, label: STATUSES[status].label, n })),
  ];

  return (
    <div className={styles.items}>
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
          items={EXPORT_FORMATS.map((format) => ({
            id: format.id,
            label: format.label,
            onSelect: () => onExport(format.id, rows),
          }))}
        />
      </div>
      <VirtualTable
        label={`Items, ${count.format(rows.length)} shown`}
        rows={rows}
        columns={COLUMNS}
        rowKey={(item) => item.index}
        empty={<p className={styles.noRows}>No items match.</p>}
      />
    </div>
  );
}
