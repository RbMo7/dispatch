import type { ReactNode } from 'react';

import { CHAINS, type Chain } from '../domain/chains';
import styles from './ChainDot.module.css';

export function ChainDot({ chain, children }: { chain: Chain; children?: ReactNode }) {
  const { label, mark } = CHAINS[chain];
  return (
    <span className={styles.chain}>
      <span className={styles.dot} style={{ background: mark }} aria-hidden="true" />
      {children ?? label}
      {children !== undefined && <span className="visually-hidden">, {label}</span>}
    </span>
  );
}
