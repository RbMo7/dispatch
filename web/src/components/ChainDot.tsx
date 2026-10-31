import type { ReactNode } from 'react';

import { CHAINS, type Chain } from '../domain/chains';
import styles from './ChainDot.module.css';

// The one dot the console allows: on the Overview's Sender rows, where the
// colour names the chain. Screen readers hear the chain's name instead.
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
