import { CaretDown } from '@phosphor-icons/react';
import { type KeyboardEvent, type ReactNode, useCallback, useId, useRef, useState } from 'react';

import { Button } from './Button';
import styles from './Menu.module.css';
import { usePopover } from './usePopover';

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
}

interface MenuProps {
  /** The trigger's text, such as "Export". */
  label: string;
  icon?: ReactNode;
  items: readonly MenuItem[];
  disabled?: boolean;
}

export function Menu({ label, icon, items, disabled }: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement & HTMLAnchorElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  usePopover(open, close, root, trigger);

  const itemsIn = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  function openAt(which: 'first' | 'last') {
    setOpen(true);
    requestAnimationFrame(() => {
      const all = itemsIn();
      (which === 'first' ? all[0] : all.at(-1))?.focus();
    });
  }

  function onTriggerKey(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openAt('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt('last');
    }
  }

  function onMenuKey(event: KeyboardEvent) {
    const all = itemsIn();
    const index = all.indexOf(document.activeElement as HTMLElement);
    const target = {
      ArrowDown: (index + 1) % all.length,
      ArrowUp: (index - 1 + all.length) % all.length,
      Home: 0,
      End: all.length - 1,
    }[event.key];
    if (event.key === 'Tab') setOpen(false);
    if (target === undefined) return;
    event.preventDefault();
    all[target]?.focus();
  }

  return (
    <div ref={root} className={styles.root}>
      <Button
        ref={trigger}
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openAt('first'))}
        onKeyDown={onTriggerKey}
      >
        {icon}
        {label}
        <CaretDown size={12} aria-hidden="true" className={styles.caret} />
      </Button>
      {open && (
        <div id={menuId} role="menu" aria-label={label} className={styles.menu} onKeyDown={onMenuKey}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={styles.item}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
