import { ArrowsClockwise, Plus, Shuffle, Tray } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { type Chain, ChainDot } from '../components/ChainDot';
import { EmptyState } from '../components/EmptyState';
import { MonoValue } from '../components/MonoValue';
import { ALL_STATUSES, type Status } from '../components/status';
import { StatusPill } from '../components/StatusPill';
import { ThemeToggle } from '../components/ThemeToggle';
import { LayoutItem, LayoutList } from '../motion/LayoutList';
import { Modal, Pane } from '../motion/Overlay';
import { Reveal } from '../motion/Reveal';
import styles from './Gallery.module.css';

const SOLANA_SIGNATURE =
  '5Kq3vTzR8mWbJ1xYhN4cLpD6sQe2Gf7aUk9oVr3BnHtXwM8jZy5CdE1iP4lS6uA2gFh7nK3qRb9TcW5vXz8m9fPa';
const BASE_HASH = '0x7f3a9c21d84e6b0f5a13c7e92d48b6f01e5a7c3d9b2f4e816a0c5d7e3b9f2a41';

interface Row {
  id: number;
  hash: string;
  chain: Chain;
  status: Status;
  items: number;
}

const SEED_ROWS: Row[] = [
  { id: 3, hash: BASE_HASH, chain: 'base', status: 'broadcasting', items: 12 },
  { id: 2, hash: SOLANA_SIGNATURE, chain: 'solana', status: 'confirmed', items: 1 },
  {
    id: 1,
    hash: '0x19be04c6f2a83d57e1c9b4a60d2f7e38c5b1a9d4e6f0832c7a5d1b9e4f6c2d07',
    chain: 'base',
    status: 'awaiting_approval',
    items: 3,
  },
];

function randomHex(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length / 2)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function nextStatus(status: Status): Status {
  return ALL_STATUSES[(ALL_STATUSES.indexOf(status) + 1) % ALL_STATUSES.length]!;
}

export function Gallery() {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <div>
          <h1 className={styles.title}>Primitives</h1>
          <p className={styles.subtitle}>Every console primitive, side by side in both themes.</p>
        </div>
        <ThemeToggle />
      </header>

      <div className={styles.themes}>
        <ThemePanel theme="light" />
        <ThemePanel theme="dark" />
      </div>

      <h2 className={styles.section}>Motion</h2>
      <p className={styles.note}>
        These follow the page theme. Turn on reduced motion in your system settings and every slide,
        spring and pulse becomes a plain fade or nothing.
      </p>
      <div className={styles.grid}>
        <StatusDemo />
        <ListDemo />
        <OverlayDemo />
      </div>

      <h2 className={styles.section}>Scroll reveal</h2>
      <div className={styles.grid}>
        {['Overview', 'Dispatches', 'Senders & Keys'].map((title, index) => (
          <Reveal key={title} index={index}>
            <Card title={title} viewAllHref="#">
              <p className={styles.muted}>Rises 16 px and fades in as it enters the viewport.</p>
            </Card>
          </Reveal>
        ))}
      </div>
    </div>
  );
}

function ThemePanel({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <section data-theme={theme} className={styles.panel} aria-label={`${theme} theme`}>
      <p className={styles.panelLabel}>{theme === 'light' ? 'Light' : 'Dark'}</p>

      <Card title="Buttons">
        <div className={styles.row}>
          <Button>Read the docs</Button>
          <Button variant="soft" arrow>
            View on GitHub
          </Button>
          <Button disabled>Disabled</Button>
        </div>
      </Card>

      <Card title="Status pills">
        <div className={styles.wrap}>
          {ALL_STATUSES.map((status) => (
            <StatusPill key={status} status={status} />
          ))}
        </div>
      </Card>

      <Card title="Recent" viewAllHref="#">
        <dl className={styles.facts}>
          <dt>Chain</dt>
          <dd className={styles.row}>
            <ChainDot chain="solana" />
            <ChainDot chain="base" />
          </dd>
          <dt>Signature</dt>
          <dd>
            <MonoValue value={SOLANA_SIGNATURE} />
          </dd>
          <dt>Transaction</dt>
          <dd>
            <MonoValue value={BASE_HASH} head={6} />
          </dd>
        </dl>
      </Card>

      <Card title="Needs attention">
        <EmptyState icon={<Tray size={18} />} title="Nothing needs you">
          Held Dispatches and approvals waiting on Approvers show up here.
        </EmptyState>
      </Card>
    </section>
  );
}

function StatusDemo() {
  const [status, setStatus] = useState<Status>('queued');
  return (
    <Card title="Status change">
      <div className={styles.stage}>
        <StatusPill status={status} />
      </div>
      <Button variant="soft" onClick={() => setStatus(nextStatus)}>
        <ArrowsClockwise size={14} aria-hidden="true" />
        Next status
      </Button>
    </Card>
  );
}

function ListDemo() {
  const [rows, setRows] = useState(SEED_ROWS);

  function add() {
    setRows((current) => [
      {
        id: Math.max(0, ...current.map((row) => row.id)) + 1,
        hash: `0x${randomHex(64)}`,
        chain: current.length % 2 === 0 ? 'solana' : 'base',
        status: 'queued',
        items: 1 + (current.length % 5),
      },
      ...current,
    ]);
  }

  function shuffle() {
    setRows((current) => [...current].sort(() => Math.random() - 0.5));
  }

  function advanceOldest() {
    setRows((current) =>
      current.map((row, index) =>
        index === current.length - 1 ? { ...row, status: nextStatus(row.status) } : row,
      ),
    );
  }

  return (
    <Card title="Layout list">
      <div className={styles.row}>
        <Button variant="soft" onClick={add}>
          <Plus size={14} aria-hidden="true" />
          Add row
        </Button>
        <Button variant="soft" onClick={shuffle}>
          <Shuffle size={14} aria-hidden="true" />
          Shuffle
        </Button>
        <Button variant="soft" onClick={advanceOldest}>
          Step oldest
        </Button>
        <Button
          variant="soft"
          disabled={rows.length === 0}
          onClick={() => setRows((r) => r.slice(1))}
        >
          Remove
        </Button>
      </div>
      <div className={styles.listFrame}>
        <LayoutList label="Demo Dispatches">
          {rows.map((row) => (
            <LayoutItem key={row.id}>
              <ChainDot chain={row.chain} hideLabel />
              <MonoValue value={row.hash} />
              <span className={styles.muted}>
                {row.items} {row.items === 1 ? 'item' : 'items'}
              </span>
              <span className={styles.push}>
                <StatusPill status={row.status} />
              </span>
            </LayoutItem>
          ))}
        </LayoutList>
      </div>
    </Card>
  );
}

function OverlayDemo() {
  const [open, setOpen] = useState<'pane' | 'modal' | null>(null);
  const close = () => setOpen(null);

  return (
    <Card title="Pane and modal">
      <p className={styles.muted}>Close with Escape, the backdrop, or the button inside.</p>
      <div className={styles.row}>
        <Button variant="soft" onClick={() => setOpen('pane')}>
          Open pane
        </Button>
        <Button variant="soft" onClick={() => setOpen('modal')}>
          Open modal
        </Button>
      </div>

      <Pane open={open === 'pane'} onClose={close} title="Dispatch 7f3a9c21">
        <div className={styles.row}>
          <StatusPill status="broadcasting" />
          <ChainDot chain="base" />
        </div>
        <dl className={styles.facts}>
          <dt>Transaction</dt>
          <dd>
            <MonoValue value={BASE_HASH} head={6} />
          </dd>
          <dt>Items</dt>
          <dd>12</dd>
        </dl>
        <Button variant="soft" onClick={close}>
          Close
        </Button>
      </Pane>

      <Modal open={open === 'modal'} onClose={close} title="Cancel this Dispatch?">
        <p className={styles.muted}>
          None of its 12 items has been claimed, so nothing is sent. This cannot be undone.
        </p>
        <div className={styles.actions}>
          <Button variant="soft" onClick={close}>
            Keep it
          </Button>
          <Button onClick={close}>Cancel Dispatch</Button>
        </div>
      </Modal>
    </Card>
  );
}
