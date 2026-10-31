import { ArrowRight } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import styles from './PillButton.module.css';

export function PillButton({
  href,
  variant = 'ink',
  arrow = false,
  children,
}: {
  href: string;
  variant?: 'ink' | 'soft';
  arrow?: boolean;
  children: ReactNode;
}) {
  return (
    <a className={`${styles.pill} ${styles[variant]}`} href={href}>
      {children}
      {arrow && <ArrowRight size={14} weight="bold" aria-hidden="true" />}
    </a>
  );
}
