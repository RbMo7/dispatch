import type { MouseEvent } from 'react';

import { lessThan, type Money, share, subtract } from '../domain/assets';
import { CHAINS, type Chain } from '../domain/chains';
import { Amount } from './Amount';
import styles from './SenderCard.module.css';
import { StackedBar } from './StackedBar';

export interface SenderCardProps {
  chain: Chain;
  /** "Squads, 2 to approve", "Safe, 2 to approve" or "Single key". */
  signing: string;
  name: string;
  /** The balance, or why the engine could not read it. */
  balance: Money | { error: string };
  committed: Money;
  /** Token balances, listed under the native one, each with what is committed of it. */
  tokens?: readonly ({ balance: Money; committed: Money } | { asset: string; error: string })[];
  /** What open work still needs from free funds; below it, the card warns. */
  needed?: Money;
  /** Who pays fees (an amount), or which Signer signs (text). */
  footer: { label: string; fee: Money } | { label: string; text: string };
  /** Something the operator must act on that is not about funds, such as another sender using the wallet. */
  warning?: string;
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export function SenderCard({
  chain,
  signing,
  name,
  balance,
  committed,
  tokens = [],
  needed,
  footer,
  warning,
  href,
  onClick,
}: SenderCardProps) {
  return (
    <a className={styles.card} href={href} onClick={onClick}>
      <div className={styles.line}>
        <span>{CHAINS[chain].label}</span>
        <span>{signing}</span>
      </div>
      <div className={styles.name}>{name}</div>
      {'error' in balance ? (
        <>
          <div className={styles.unread}>Balance unavailable</div>
          <div className={styles.line}>
            <span className={styles.low}>{balance.error}</span>
          </div>
        </>
      ) : (
        <Funds balance={balance} committed={committed} needed={needed} />
      )}
      {tokens.length > 0 && (
        <ul className={styles.tokens}>
          {tokens.map((token) =>
            'error' in token ? (
              <li key={token.asset} className={styles.token}>
                <span>{token.asset}</span>
                <span className={styles.low}>Unavailable</span>
              </li>
            ) : (
              <li key={token.balance.asset} className={styles.token}>
                <Amount {...token.balance} variant="plain" unit tip={false} />
                {BigInt(token.committed.raw) > 0n && (
                  <span>
                    <Amount {...token.committed} variant="plain" tip={false} /> committed
                  </span>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      {warning && <div className={styles.warning}>{warning}</div>}
      <div className={styles.footer}>
        <span>{footer.label}</span>
        <span className={styles.footerValue}>
          {'fee' in footer ? (
            <Amount {...footer.fee} variant="plain" unit tip={false} />
          ) : (
            footer.text
          )}
        </span>
      </div>
    </a>
  );
}

function Funds({
  balance,
  committed,
  needed,
}: {
  balance: Money;
  committed: Money;
  needed: Money | undefined;
}) {
  const free = subtract(balance, committed);
  const low = lessThan(free, needed ?? { ...free, raw: '0' });
  return (
    <>
      <div className={styles.balance}>
        <Amount {...balance} variant="raised" tip={false} />
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
    </>
  );
}
