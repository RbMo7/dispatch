import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useRef } from 'react';

import styles from './VirtualTable.module.css';

export const ROW_HEIGHT = 32;

export interface Column<Row> {
  id: string;
  header: string;
  /** A CSS grid track, such as `56px` or `minmax(0, 1fr)`. */
  width: string;
  align?: 'start' | 'end';
  render: (row: Row) => ReactNode;
}

interface VirtualTableProps<Row> {
  label: string;
  rows: readonly Row[];
  columns: readonly Column<Row>[];
  rowKey: (row: Row) => string | number;
  /** The scroll area's height in px; without it the table fills its flex parent. */
  height?: number;
  empty?: ReactNode;
}

export function VirtualTable<Row>({ label, rows, columns, rowKey, height, empty }: VirtualTableProps<Row>) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // jsdom and first paint have no layout; assume the scroll area's size.
    initialRect: { width: 0, height: height ?? 480 },
  });
  const template = columns.map((column) => column.width).join(' ');

  return (
    <div className={styles.table} role="table" aria-label={label} aria-rowcount={rows.length + 1}>
      <div className={styles.header} role="row" aria-rowindex={1} style={{ gridTemplateColumns: template }}>
        {columns.map((column) => (
          <span key={column.id} role="columnheader" className={styles.cell} data-align={column.align}>
            {column.header}
          </span>
        ))}
      </div>
      <div ref={scroller} className={styles.scroller} style={height === undefined ? undefined : { height }}>
        {rows.length === 0 ? (
          empty
        ) : (
          <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtual) => {
              const row = rows[virtual.index]!;
              return (
                <div
                  key={rowKey(row)}
                  role="row"
                  aria-rowindex={virtual.index + 2}
                  className={styles.row}
                  style={{ gridTemplateColumns: template, transform: `translateY(${virtual.start}px)` }}
                >
                  {columns.map((column) => (
                    <span key={column.id} role="cell" className={styles.cell} data-align={column.align}>
                      {column.render(row)}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
