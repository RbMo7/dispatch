import {
  ArrowClockwise,
  ClockCounterClockwise,
  Coins,
  FileText,
  Flag,
  HandPalm,
  Key,
  ListChecks,
  Prohibit,
  Rows,
  SignOut,
  SquaresFour,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Button } from '../components/Button';
import { EyeToggle } from '../components/EyeToggle';
import styles from './console.module.css';
import type { Connection } from './live';
import { OPERATOR_PAGES, type Page, PAGES } from './router';

const NAV = [
  { page: 'overview', label: 'Overview', Icon: SquaresFour },
  { page: 'dispatches', label: 'Dispatches', Icon: Rows },
  { page: 'held', label: 'Held', Icon: HandPalm },
  { page: 'rules', label: 'Flag Rules', Icon: Flag },
  { page: 'senders', label: 'Senders & Keys', Icon: Key },
  { page: 'assets', label: 'Assets', Icon: Coins },
  { page: 'activity', label: 'Activity', Icon: ClockCounterClockwise },
  { page: 'rejected', label: 'Rejected', Icon: Prohibit },
  { page: 'setup', label: 'Setup', Icon: ListChecks },
] as const satisfies readonly { page: Page; label: string; Icon: unknown }[];

const count = new Intl.NumberFormat('en-US');

interface SidebarProps {
  current: Page | null;
  /** Whether the session holds OPERATOR_TOKEN: without it, the operator pages are left out. */
  operator: boolean;
  /** How many Dispatches are held, beside Held; null until read. */
  held?: number | null | undefined;
  /** The Sender cards, or their loading or error state. */
  senders: ReactNode;
  instance: string;
  connection: Connection;
  onRefresh?: () => void;
  /** Navigates in place; without it the links load the page. */
  onNavigate?: (page: Page) => void;
  onSignOut?: () => void;
}

export function Sidebar({
  current,
  operator,
  held = null,
  senders,
  instance,
  connection,
  onRefresh,
  onNavigate,
  onSignOut,
}: SidebarProps) {
  const go = (page: Page) => (event: React.MouseEvent) => {
    if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(page);
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brandRow}>
        <span className={styles.brand}>dispatch</span>
        <Button variant="quiet" icon aria-label="Refresh" title="Refresh" onClick={onRefresh}>
          <ArrowClockwise size={15} aria-hidden="true" />
        </Button>
      </div>
      <nav className={styles.nav} aria-label="Console">
        {NAV.filter((item) => operator || !OPERATOR_PAGES.has(item.page)).map((item) => (
          <a
            key={item.page}
            className={styles.navItem}
            href={PAGES[item.page]}
            aria-current={current === item.page ? 'page' : undefined}
            onClick={go(item.page)}
          >
            <item.Icon size={16} aria-hidden="true" />
            {item.label}
            {item.page === 'held' && held !== null && held > 0 && (
              <span className={styles.navCount}>{count.format(held)}</span>
            )}
          </a>
        ))}
      </nav>
      <div className={styles.sendersHead}>
        <span className={styles.sendersLabel}>Senders</span>
        <EyeToggle />
        <a className={styles.allLink} href={PAGES.senders} onClick={go('senders')}>
          All ›
        </a>
      </div>
      <div className={styles.senders}>{senders}</div>
      <div className={styles.sidebarFoot}>
        <a className={styles.navItem} href="/docs">
          <FileText size={16} aria-hidden="true" />
          Docs
        </a>
        {onSignOut && (
          <button type="button" className={styles.navItem} onClick={onSignOut}>
            <SignOut size={16} aria-hidden="true" />
            Sign out
          </button>
        )}
        <div className={styles.instance}>
          <span className={styles.instanceName} title={instance}>
            {instance}
          </span>
          <span
            className={styles.connection}
            data-connection={connection}
            role="status"
            aria-live="polite"
          >
            {connection === 'live' ? 'Live' : 'Reconnecting'}
          </span>
        </div>
      </div>
    </aside>
  );
}
