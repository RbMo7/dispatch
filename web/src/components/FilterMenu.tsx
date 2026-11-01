import { CaretDown, Check } from '@phosphor-icons/react';
import { type KeyboardEvent, useCallback, useId, useRef, useState } from 'react';

import { Button } from './Button';
import menu from './Menu.module.css';
import styles from './FilterMenu.module.css';
import { usePopover } from './usePopover';

export interface FilterGroup {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}

interface FilterMenuProps {
  /** The trigger's text, such as "Filters"; the count of groups not at their first option follows it. */
  label: string;
  groups: readonly FilterGroup[];
}

/** One menu of single-choice groups, such as status and mode; it stays open while choosing. */
export function FilterMenu({ label, groups }: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement & HTMLAnchorElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  usePopover(open, close, root, trigger);
  const active = groups.filter((group) => group.value !== group.options[0]?.value).length;

  function focusItem(which: 'first' | 'checked') {
    requestAnimationFrame(() => {
      const items = [
        ...(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
      ];
      (which === 'checked'
        ? (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])
        : items[0]
      )?.focus();
    });
  }

  function onMenuKey(event: KeyboardEvent) {
    const items = [
      ...(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const target = {
      ArrowDown: (index + 1) % items.length,
      ArrowUp: (index - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }[event.key];
    if (event.key === 'Tab') setOpen(false);
    if (target === undefined) return;
    event.preventDefault();
    items[target]?.focus();
  }

  return (
    <div ref={root} className={menu.root}>
      <Button
        ref={trigger}
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen(!open);
          if (!open) focusItem('checked');
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            focusItem('first');
          }
        }}
      >
        {label}
        {active > 0 && <span className={styles.count}>{active}</span>}
        <CaretDown size={12} aria-hidden="true" className={menu.caret} />
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={`${menu.menu} ${styles.menu}`}
          onKeyDown={onMenuKey}
        >
          {groups.map((group) => (
            <div key={group.id} role="group" aria-label={group.label} className={styles.group}>
              <div className={styles.groupLabel} aria-hidden="true">
                {group.label}
              </div>
              {group.options.map((option) => {
                const checked = option.value === group.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    tabIndex={-1}
                    className={`${menu.item} ${styles.option}`}
                    onClick={() => group.onChange(option.value)}
                  >
                    {option.label}
                    {checked && <Check size={13} aria-hidden="true" className={styles.check} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
