import { X } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Button } from './Button';
import styles from './DockedPane.module.css';

interface DockedPaneProps {
  /** "Managed Dispatch" or "Relay Dispatch". */
  title: string;
  /** Beside the title, such as the Dispatch's mono id. */
  meta?: ReactNode;
  label: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

export function DockedPane({ title, meta, label, onClose, footer, children }: DockedPaneProps) {
  return (
    <section className={styles.pane} aria-label={label}>
      <header className={styles.head}>
        <span className={styles.title}>{title}</span>
        {meta}
        <Button variant="quiet" icon aria-label="Close" className={styles.close} onClick={onClose}>
          <X size={14} weight="bold" aria-hidden="true" />
        </Button>
      </header>
      <div className={styles.body}>{children}</div>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </section>
  );
}
