import { DownloadSimple } from '@phosphor-icons/react';

import { Checkbox } from '../../components/Checkbox';
import { DateRangeControl } from '../../components/DateRangeControl';
import { Menu } from '../../components/Menu';
import { SearchField } from '../../components/SearchField';
import { SegmentedControl } from '../../components/SegmentedControl';
import type { Chain } from '../../domain/chains';
import type { DayRange } from '../../domain/dateRange';
import { EXPORT_FORMATS, type ExportFormat } from '../../export/download';
import styles from '../console.module.css';
import { DispatchRows } from '../dispatches/DispatchRows';
import { FIXTURE_TODAY, type GalleryDispatch } from '../fixtures';

export type ChainFilter = 'all' | Chain;

const CHAIN_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'solana', label: 'Solana' },
  { value: 'base', label: 'Base' },
] as const;

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

/** The Dispatches screen's page bar over the console's own rows, on recorded data. */
export function DispatchList(props: DispatchListProps) {
  const { rows, checked } = props;
  const allChecked = rows.length > 0 && rows.every((row) => checked.has(row.id));
  const someChecked = rows.some((row) => checked.has(row.id));

  return (
    <main className={styles.main}>
      <div className={styles.pageBar}>
        <Checkbox
          aria-label="Select every Dispatch shown"
          checked={allChecked}
          indeterminate={someChecked && !allChecked}
          onChange={(event) =>
            props.onCheck(
              rows.map((row) => row.id),
              event.target.checked,
            )
          }
        />
        <h1 className={styles.pageTitle}>Dispatches</h1>
        <div className={styles.controls}>
          <DateRangeControl value={props.range} onChange={props.onRange} today={FIXTURE_TODAY} />
          <SegmentedControl
            label="Chain"
            options={CHAIN_OPTIONS}
            value={props.chain}
            onChange={props.onChain}
          />
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
      <DispatchRows
        rows={rows}
        selected={props.selected}
        onSelect={props.onSelect}
        today={FIXTURE_TODAY}
        nameOf={(row) => row.label}
        checked={checked}
        onCheck={props.onCheck}
        empty={<p className={styles.noRows}>No Dispatches match these filters.</p>}
      />
    </main>
  );
}
