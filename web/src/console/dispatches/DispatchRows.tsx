import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';

import { Amount } from '../../components/Amount';
import { Checkbox } from '../../components/Checkbox';
import { StatusPill } from '../../components/StatusPill';
import { CHAINS } from '../../domain/chains';
import { dayKey } from '../../domain/dateRange';
import { dispatchName, type DispatchSummary, shortId } from '../../domain/dispatch';
import { layoutSpring, rowEnter } from '../../motion/transitions';
import styles from '../console.module.css';

const longDay = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});

export function dayHeading(date: Date, today: Date): string {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(today) - start(date)) / 86_400_000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : longDay.format(date);
}

interface DispatchRowsProps<Row extends DispatchSummary> {
  rows: readonly Row[];
  selected: string | null;
  onSelect: (id: string) => void;
  today: Date;
  /** The engine keeps no label; the gallery's recorded data has one. */
  nameOf?: (row: Row) => string;
  /** The Sender's name, given only where the row's chain has more than one Sender. */
  senderOf?: (row: Row) => string | null;
  /** Row checkboxes, where the screen has something to do with a selection. */
  checked?: ReadonlySet<string>;
  onCheck?: (ids: string[], on: boolean) => void;
  empty?: ReactNode;
  /** After the last row: the infinite scroll sentinel, or the end of the list. */
  footer?: ReactNode;
}

/** Day-grouped rows that reflow with a spring as polls reorder or insert them. */
export function DispatchRows<Row extends DispatchSummary>({
  rows,
  selected,
  onSelect,
  today,
  nameOf = dispatchName,
  senderOf,
  checked,
  onCheck,
  empty,
  footer,
}: DispatchRowsProps<Row>) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return (
    <div className={styles.list} data-dispatch-list>
      {rows.length === 0 && empty}
      <AnimatePresence initial={false} mode="popLayout">
        {[...groups].flatMap(([day, dayRows]) => [
          <motion.div
            key={`day-${day}`}
            layout="position"
            transition={layoutSpring}
            className={styles.dayHead}
          >
            {dayHeading(dayRows[0]!.createdAt, today)}
          </motion.div>,
          ...dayRows.map((row) => (
            <motion.div
              key={row.id}
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ layout: layoutSpring, default: rowEnter }}
              className={styles.row}
              data-selected={row.id === selected || undefined}
            >
              {checked && onCheck && (
                <Checkbox
                  aria-label={`Select ${nameOf(row)}, ${shortId(row.id)}`}
                  checked={checked.has(row.id)}
                  onChange={(event) => onCheck([row.id], event.target.checked)}
                />
              )}
              <button
                type="button"
                className={styles.rowMain}
                data-row={row.id}
                aria-current={row.id === selected || undefined}
                onClick={() => onSelect(row.id)}
              >
                <span className={styles.rowName}>{nameOf(row)}</span>
                <span className={styles.rowSub}>
                  <span className={styles.mono}>{shortId(row.id)}</span>
                </span>
                <span className={styles.rowSub}>
                  {CHAINS[row.chain].label}
                  {senderOf?.(row) && `, ${senderOf(row)}`}
                </span>
                <span className={styles.spacer} />
                <StatusPill status={row.status} />
                <span className={styles.rowAmount}>
                  {row.totals[0] ? (
                    <Amount {...row.totals[0]} />
                  ) : (
                    <span className={styles.rowSub}>
                      {row.mode === 'relay' ? 'Relay' : 'Calls'}
                    </span>
                  )}
                </span>
              </button>
            </motion.div>
          )),
        ])}
      </AnimatePresence>
      {footer}
    </div>
  );
}
