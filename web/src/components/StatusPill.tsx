import { type Status, STATUSES } from '../domain/status';
import styles from './StatusPill.module.css';

// Text on a tint, nothing else. A status change cross-fades the colours over
// 160 ms; the width snaps, so neighbours never slide.
export function StatusPill({ status }: { status: Status }) {
  const { label, pill } = STATUSES[status];
  return (
    <span className={styles.pill} data-status={status} style={pill}>
      {label}
    </span>
  );
}
