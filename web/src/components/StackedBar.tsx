import styles from './StackedBar.module.css';

interface StackedBarProps {
  /** The committed share of the whole, 0 to 1; the rest of the track is free. */
  committed: number;
  /** Free funds are below what open work needs. */
  low?: boolean;
}

export function StackedBar({ committed, low = false }: StackedBarProps) {
  const width = `${Math.min(1, Math.max(0, committed)) * 100}%`;
  return (
    <div className={styles.track} aria-hidden="true">
      <span className={styles.fill} data-low={low || undefined} style={{ width }} />
    </div>
  );
}
