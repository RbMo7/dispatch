import { type Status, STATUSES } from '../domain/status';
import styles from './StatusPill.module.css';

export function StatusPill({ status }: { status: Status }) {
  const { label, pill } = STATUSES[status];
  return (
    <span className={styles.pill} data-status={status} style={pill}>
      {label}
    </span>
  );
}
