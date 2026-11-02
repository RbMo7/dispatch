import { DECISIONS } from '../domain/approval';
import type { Approver } from '../domain/dispatch';
import styles from './ApproverList.module.css';
import { MonoValue } from './MonoValue';
import { Pill } from './StatusPill';

/** Who can approve and where each stands: the label (or the address) and the decision in words. */
export function ApproverList({ approvers }: { approvers: readonly Approver[] }) {
  if (approvers.length === 0) {
    return <p className={styles.none}>Approvers appear once the engine reads the Proposal.</p>;
  }
  return (
    <ul className={styles.list} aria-label="Approvers">
      {approvers.map((approver) => (
        <li key={approver.address} className={styles.row}>
          <span className={styles.who}>
            {approver.label && <span className={styles.label}>{approver.label}</span>}
            <span className={approver.label ? styles.address : undefined}>
              <MonoValue value={approver.address} head={4} tail={4} />
            </span>
          </span>
          <Pill
            tone={DECISIONS[approver.decision].tone}
            label={DECISIONS[approver.decision].label}
          />
        </li>
      ))}
    </ul>
  );
}
