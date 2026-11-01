import { ApproverList } from '../../components/ApproverList';
import { approvalProgress, type ProposalApproval } from '../../domain/approval';
import { type Network, proposalApp, proposalUrl } from '../../domain/chains';
import { proposalName } from '../../domain/dispatchFlow';
import styles from '../console.module.css';

/** More than this many Proposals collapse into a count: the Flow tab carries the totals. */
const SHOWN = 3;

const count = new Intl.NumberFormat('en-US');
const deadlineFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Who approved each Proposal, who has not, and how many approvals it still needs. */
export function ProposalApprovals({
  proposals,
  network,
}: {
  proposals: readonly ProposalApproval[];
  network: Network;
}) {
  const hidden = proposals.length - SHOWN;
  return (
    <div className={styles.proposals}>
      {proposals.slice(0, SHOWN).map(({ approval, items }) => {
        const ref = approval.chainRef;
        const app = proposalApp(ref);
        const href = proposalUrl(network, ref);
        return (
          <section
            key={ref.kind === 'squads' ? ref.proposal : ref.safeTxHash}
            className={styles.proposal}
            aria-label={`Proposal ${proposalName(ref)} in ${app}`}
          >
            <div className={styles.proposalHead}>
              <span>
                Proposal {proposalName(ref)} in {app}
              </span>
              <span className={styles.muted}>
                {count.format(items.length)} {items.length === 1 ? 'item' : 'items'}
              </span>
            </div>
            <div className={styles.proposalProgress}>{approvalProgress(approval)}</div>
            <ApproverList approvers={approval.approvers} />
            <div className={styles.proposalFoot}>
              <span className={styles.muted}>
                Deadline {deadlineFormat.format(approval.deadline)}
              </span>
              {href && (
                <a className={styles.proposalLink} href={href} target="_blank" rel="noreferrer">
                  Open in {app} ›
                </a>
              )}
            </div>
          </section>
        );
      })}
      {hidden > 0 && (
        <p className={styles.muted}>
          {count.format(hidden)} more {hidden === 1 ? 'Proposal' : 'Proposals'}, counted in the Flow
          tab.
        </p>
      )}
    </div>
  );
}
