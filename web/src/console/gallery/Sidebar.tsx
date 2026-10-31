import {
  ArrowClockwise,
  ClockCounterClockwise,
  FileText,
  Key,
  Pause,
  Rows,
  SquaresFour,
} from '@phosphor-icons/react';

import { Button } from '../../components/Button';
import { EyeToggle } from '../../components/EyeToggle';
import { SenderCard } from '../../components/SenderCard';
import { money } from '../fixtures';
import styles from './Gallery.module.css';

const NAV = [
  { label: 'Overview', href: '#overview', Icon: SquaresFour },
  { label: 'Dispatches', href: '#dispatches', Icon: Rows, current: true },
  { label: 'Held', href: '#held', Icon: Pause, count: 2 },
  { label: 'Senders & Keys', href: '#senders', Icon: Key },
  { label: 'Activity', href: '#activity', Icon: ClockCounterClockwise },
] as const;

export function Sidebar() {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brandRow}>
        <span className={styles.brand}>dispatch</span>
        <Button variant="quiet" icon aria-label="Refresh">
          <ArrowClockwise size={15} aria-hidden="true" />
        </Button>
      </div>
      <nav className={styles.nav} aria-label="Console">
        {NAV.map((item) => (
          <a
            key={item.label}
            className={styles.navItem}
            href={item.href}
            aria-current={'current' in item ? 'page' : undefined}
          >
            <item.Icon size={16} aria-hidden="true" />
            {item.label}
            {'count' in item && <span className={styles.navCount}>{item.count}</span>}
          </a>
        ))}
      </nav>
      <div className={styles.sendersHead}>
        <span className={styles.sendersLabel}>Senders</span>
        <EyeToggle />
        <a className={styles.allLink} href="#senders">
          All ›
        </a>
      </div>
      <div className={styles.senders}>
        <SenderCard
          chain="solana"
          signing="Squads, 2 of 3"
          name="Treasury vault"
          balance={money('1842.30', 'USDC')}
          committed={money('700.00', 'USDC')}
          needed={money('420.00', 'USDC')}
          footer={{ label: 'Fees from member key', fee: money('0.4182', 'SOL') }}
          href="#senders"
        />
        <SenderCard
          chain="base"
          signing="Single key"
          name="Payouts sender"
          balance={money('0.8412', 'ETH')}
          committed={money('0.7650', 'ETH')}
          needed={money('0.1200', 'ETH')}
          footer={{ label: 'Signer', text: 'AWS KMS, pinned' }}
          href="#senders"
        />
      </div>
      <div className={styles.sidebarFoot}>
        <a className={styles.navItem} href="/docs">
          <FileText size={16} aria-hidden="true" />
          Docs
        </a>
        <div className={styles.instance}>
          dispatch-eu-1<span>Live</span>
        </div>
      </div>
    </aside>
  );
}
