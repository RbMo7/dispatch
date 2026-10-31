import styles from './ChainDot.module.css';

export const CHAINS = {
  solana: { label: 'Solana', colour: 'var(--chain-solana)' },
  base: { label: 'Base', colour: 'var(--chain-base)' },
} as const;

export type Chain = keyof typeof CHAINS;

export function ChainDot({ chain, hideLabel = false }: { chain: Chain; hideLabel?: boolean }) {
  const { label, colour } = CHAINS[chain];
  return (
    <span className={styles.chain}>
      <span className={styles.dot} style={{ background: colour }} aria-hidden="true" />
      <span className={hideLabel ? styles.hidden : undefined}>{label}</span>
    </span>
  );
}
