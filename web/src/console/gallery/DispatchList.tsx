import { DownloadSimple } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';

import { Amount } from '../../components/Amount';
import { Checkbox } from '../../components/Checkbox';
import { DateRangeControl } from '../../components/DateRangeControl';
import { Menu } from '../../components/Menu';
import { SearchField } from '../../components/SearchField';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusPill } from '../../components/StatusPill';
import { CHAINS, type Chain } from '../../domain/chains';
import { type DayRange, dayKey } from '../../domain/dateRange';
import { EXPORT_FORMATS, type ExportFormat } from '../../export/download';
import { layoutSpring, rowEnter } from '../../motion/transitions';
import { FIXTURE_TODAY, type GalleryDispatch } from '../fixtures';
import styles from './Gallery.module.css';

export type ChainFilter = 'all' | Chain;

const CHAIN_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'solana', label: 'Solana' },
  { value: 'base', label: 'Base' },
] as const;

const longDay = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

function dayHeading(date: Date): string {
  const days = Math.round((FIXTURE_TODAY.getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : longDay.format(date);
}

interface DispatchListProps {
  rows: readonly GalleryDispatch[];
  selected: string | null;
  onSelect: (id: string) => void;
  checked: ReadonlySet<string>;
  onCheck: (ids: string[], on: boolean) => void;
  range: DayRange;
  onRange: (range: DayRange) => void;
  chain: ChainFilter;
  onChain: (chain: ChainFilter) => void;
  search: string;
  onSearch: (search: string) => void;
  onExport: (format: ExportFormat) => void;
}

export function DispatchList(props: DispatchListProps) {
  const { rows, selected, checked } = props;
  const groups = new Map<string, GalleryDispatch[]>();
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const allChecked = rows.length > 0 && rows.every((row) => checked.has(row.id));
  const someChecked = rows.some((row) => checked.has(row.id));

  return (
    <main className={styles.main}>
      <div className={styles.pageBar}>
        <Checkbox
          aria-label="Select every Dispatch shown"
          checked={allChecked}
          indeterminate={someChecked && !allChecked}
          onChange={(event) => props.onCheck(rows.map((row) => row.id), event.target.checked)}
        />
        <h1 className={styles.pageTitle}>Dispatches</h1>
        <div className={styles.controls}>
          <DateRangeControl value={props.range} onChange={props.onRange} today={FIXTURE_TODAY} />
          <SegmentedControl label="Chain" options={CHAIN_OPTIONS} value={props.chain} onChange={props.onChain} />
          <SearchField
            label="Search Dispatches by id or address"
            placeholder="Search"
            value={props.search}
            onChange={props.onSearch}
            width={150}
          />
          <Menu
            label="Export"
            icon={<DownloadSimple size={14} aria-hidden="true" />}
            items={EXPORT_FORMATS.map((format) => ({
              id: format.id,
              label: format.label,
              onSelect: () => props.onExport(format.id),
            }))}
          />
        </div>
      </div>
      <div className={styles.list} data-dispatch-list>
        {rows.length === 0 && <p className={styles.noRows}>No Dispatches match these filters.</p>}
        <AnimatePresence initial={false} mode="popLayout">
          {[...groups].flatMap(([day, dayRows]) => [
            <motion.div
              key={`day-${day}`}
              layout
              transition={layoutSpring}
              className={styles.dayHead}
            >
              {dayHeading(dayRows[0]!.createdAt)}
            </motion.div>,
            ...dayRows.map((row) => (
              <motion.div
                key={row.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ layout: layoutSpring, default: rowEnter }}
                className={styles.row}
                data-selected={row.id === selected || undefined}
              >
                <Checkbox
                  aria-label={`Select ${row.label ?? row.id}`}
                  checked={checked.has(row.id)}
                  onChange={(event) => props.onCheck([row.id], event.target.checked)}
                />
                <button
                  type="button"
                  className={styles.rowMain}
                  data-row={row.id}
                  aria-current={row.id === selected || undefined}
                  onClick={() => props.onSelect(row.id)}
                >
                  <span className={styles.rowName}>{row.label ?? `${row.itemCount} payments`}</span>
                  <span className={styles.rowSub}>
                    <span className={styles.mono}>{row.id}</span>
                  </span>
                  <span className={styles.rowSub}>{CHAINS[row.chain].label}</span>
                  <span className={styles.spacer} />
                  <StatusPill status={row.status} />
                  <span className={styles.rowAmount}>
                    <Amount {...row.totals[0]!} />
                  </span>
                </button>
              </motion.div>
            )),
          ])}
        </AnimatePresence>
      </div>
    </main>
  );
}

