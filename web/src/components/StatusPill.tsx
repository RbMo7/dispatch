import { type Status, STATUSES } from '../domain/status';
import styles from './StatusPill.module.css';

/** Text on the tint of a Dispatch status, for any status that borrows its colour. */
export function Pill({ tone, label }: { tone: Status; label: string }) {
  return (
    <span className={styles.pill} data-status={tone} style={STATUSES[tone].pill}>
      {label}
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  return <Pill tone={status} label={STATUSES[status].label} />;
}
