import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ClassNames, type DateRange as PickerRange, DayPicker } from 'react-day-picker';

import {
  type DayRange,
  dayKey,
  describeRange,
  parseDay,
  PRESETS,
  presetOf,
  presetRange,
} from '../domain/dateRange';
import { Button } from './Button';
import styles from './DateRangeControl.module.css';
import { SegmentedControl } from './SegmentedControl';
import { usePopover } from './usePopover';

interface DateRangeControlProps {
  value: DayRange;
  onChange: (range: DayRange) => void;
  /** The day presets count back from; tests and fixtures pin it. */
  today?: Date;
}

const OPTIONS = PRESETS.map(({ value, label }) => ({ value, label }));

export function DateRangeControl({ value, onChange, today = new Date() }: DateRangeControlProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PickerRange | undefined>();
  const root = useRef<HTMLDivElement>(null);
  const custom = useRef<HTMLElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopover(open, close, root, custom);

  useEffect(() => {
    custom.current = root.current?.querySelector('[data-value="custom"]') ?? null;
  }, []);

  function openCustom() {
    setDraft({ from: parseDay(value.from), to: parseDay(value.to) });
    setOpen(true);
  }

  function apply() {
    if (!draft?.from) return;
    onChange({ from: dayKey(draft.from), to: dayKey(draft.to ?? draft.from) });
    setOpen(false);
    custom.current?.focus();
  }

  const preset = presetOf(value, today);
  const end = parseDay(value.to);

  return (
    <div ref={root} className={styles.root}>
      <SegmentedControl
        label="Date range"
        options={OPTIONS}
        value={preset}
        onChange={(next) => (next === 'custom' ? openCustom() : onChange(presetRange(next, today)))}
      />
      {open && (
        <div className={styles.popover} role="dialog" aria-label="Choose a date range">
          <DayPicker
            mode="range"
            numberOfMonths={2}
            defaultMonth={new Date(end.getFullYear(), end.getMonth() - 1, 1)}
            selected={draft}
            onSelect={setDraft}
            disabled={{ after: today }}
            weekStartsOn={1}
            autoFocus
            classNames={CLASS_NAMES}
            components={{
              Chevron: ({ orientation }) =>
                orientation === 'left' ? (
                  <CaretLeft size={14} aria-hidden="true" />
                ) : (
                  <CaretRight size={14} aria-hidden="true" />
                ),
            }}
          />
          <div className={styles.footer}>
            <span className={styles.selection}>
              {draft?.from
                ? describeRange({ from: dayKey(draft.from), to: dayKey(draft.to ?? draft.from) })
                : 'Choose the first day'}
            </span>
            <Button variant="quiet" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!draft?.from} onClick={apply}>
              Apply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const CLASS_NAMES = Object.fromEntries(
  Object.entries({
    root: styles.calendar,
    months: styles.months,
    month: styles.month,
    month_caption: styles.caption,
    caption_label: styles.captionLabel,
    nav: styles.nav,
    button_previous: styles.navButton,
    button_next: styles.navButton,
    month_grid: styles.grid,
    weekday: styles.weekday,
    day: styles.day,
    day_button: styles.dayButton,
    today: styles.today,
    outside: styles.outside,
    disabled: styles.disabled,
    hidden: styles.hidden,
    selected: styles.selected,
    range_start: styles.rangeStart,
    range_middle: styles.rangeMiddle,
    range_end: styles.rangeEnd,
    focused: styles.focused,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined),
) as Partial<ClassNames>;
