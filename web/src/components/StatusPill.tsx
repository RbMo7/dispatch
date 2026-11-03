import { type DispatchSummary, shownStatus } from '../domain/dispatch';
import { type Status, STATUSES } from '../domain/status';
import styles from './StatusPill.module.css';

/** Text on the tint of a Dispatch status, for any status that borrows its colour. */
export function Pill({
  tone,
  label,
  title,
}: {
  tone: Status;
  label: string;
  title?: string | undefined;
}) {
  return (
    <span className={styles.pill} data-status={tone} style={STATUSES[tone].pill} title={title}>
      {label}
    </span>
  );
}

export function StatusPill({ status, title }: { status: Status; title?: string | undefined }) {
  return <Pill tone={status} label={STATUSES[status].label} title={title} />;
}

/** A Dispatch's status as the console shows it: Abandoned, not Failed, when every item was abandoned (#188). */
export function DispatchStatusPill({
  summary,
}: {
  summary: Pick<DispatchSummary, 'status' | 'abandoned'>;
}) {
  const shown = shownStatus(summary);
  return <StatusPill status={shown.status} title={shown.note ?? undefined} />;
}
