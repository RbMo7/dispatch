import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';

import { fade } from '../motion/transitions';
import styles from './Tabs.module.css';

export interface Tab<T extends string> {
  id: T;
  label: string;
}

interface TabsProps<T extends string> {
  label: string;
  tabs: readonly Tab<T>[];
  value: T;
  onChange: (id: T) => void;
  /** The panel for the selected tab; it cross-fades when the tab changes. */
  children: ReactNode;
}

export function Tabs<T extends string>({ label, tabs, value, onChange, children }: TabsProps<T>) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const tabId = (id: T) => `${base}-tab-${id}`;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === value);
    const target = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = tabs[target]!;
    onChange(next.id);
    document.getElementById(tabId(next.id))?.focus();
  }

  return (
    <>
      <div
        ref={list}
        className={styles.list}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const selected = tab.id === value;
          return (
            <button
              key={tab.id}
              id={tabId(tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${base}-panel`}
              tabIndex={selected ? 0 : -1}
              className={styles.tab}
              onClick={() => onChange(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={value}
          id={`${base}-panel`}
          role="tabpanel"
          aria-labelledby={tabId(value)}
          className={styles.panel}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fade}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </>
  );
}
