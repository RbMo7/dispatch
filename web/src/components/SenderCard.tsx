import { lessThan, type Money, share, subtract } from '../domain/assets';
import { CHAINS, type Chain } from '../domain/chains';
import { Amount } from './Amount';
import styles from './SenderCard.module.css';
import { StackedBar } from './StackedBar';

export interface SenderCardProps {
  chain: Chain;
  /** "Squads, 2 of 3", "Safe, 2 of 3" or "Single key". */
  signing: string;
  name: string;
  balance: Money;
  committed: Money;
  /** What open work still needs from free funds; below it, the card warns. */
  needed?: Money;
  /** Who pays fees (an amount), or which Signer signs (text). */
  footer: { label: string; fee: Money } | { label: string; text: string };
  href: string;
}

export function SenderCard({
  chain,
  signing,
  name,
  balance,
  committed,
  needed,
  footer,
  href,
}: SenderCardProps) {
  const free = subtract(balance, committed);
  const low = needed !== undefined && lessThan(free, needed);

  return (
    <a className={styles.card} href={href}>
      <div className={styles.line}>
        <span>{CHAINS[chain].label}</span>
        <span>{signing}</span>
      </div>
      <div className={styles.name}>{name}</div>
      <div className={styles.balance}>
        <Amount {...balance} variant="raised" />
      </div>
      <div className={styles.bar}>
        <StackedBar committed={share(committed, balance)} low={low} />
      </div>
      <div className={styles.line}>
        <span>
          <Amount {...committed} variant="plain" /> committed
        </span>
        <span className={low ? styles.low : undefined}>
          <Amount {...free} variant="plain" /> free
        </span>
      </div>
      <div className={styles.footer}>
        <span>{footer.label}</span>
        <span className={styles.footerValue}>
          {'fee' in footer ? <Amount {...footer.fee} variant="plain" unit /> : footer.text}
        </span>
      </div>
    </a>
  );
}
