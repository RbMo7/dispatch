import { useEffect, useMemo, useState } from 'react';

import { Amount } from '../../components/Amount';
import { Button } from '../../components/Button';
import { DockedPane } from '../../components/DockedPane';
import { EmptyState } from '../../components/EmptyState';
import { MonoValue, truncateMiddle } from '../../components/MonoValue';
import { StatusPill } from '../../components/StatusPill';
import { useToast } from '../../components/Toast';
import { type Column, VirtualTable } from '../../components/VirtualTable';
import {
  dispatchName,
  type DispatchSummary,
  type Item,
  itemTarget,
  type ManagedDetail,
} from '../../domain/dispatch';
import { duration } from '../../domain/dispatchFlow';
import { describeCheck, type Hold, matchedItems } from '../../domain/flagRules';
import { describeFailure } from '../api/client';
import styles from '../console.module.css';
import { CancelModal } from '../dispatches/CancelModal';
import { useDispatch } from '../dispatches/data';
import type { PaneHead } from '../dispatches/DispatchPane';
import { whenText } from '../dispatches/DispatchesPage';
import { DispatchRows } from '../dispatches/DispatchRows';
import { useLive } from '../live';
import ops from '../operator.module.css';
import { Link, useRouter } from '../router';
import { useSharedChains } from '../senderData';
import { PageBar } from '../Shell';
import { useHeld } from './heldData';
import { ReleaseModal } from './ReleaseModal';

const count = new Intl.NumberFormat('en-US');
const clock = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A clock for "held for": a hold has no deadline, so a minute is fine enough. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The review queue: every held Dispatch, oldest first, with how long it has waited. */
export function HeldPage() {
  const { params, replaceParams } = useRouter();
  const held = useHeld();
  const shared = useSharedChains();
  const now = useNow();
  const selected = params.get('dispatch');
  const select = (id: string | null) =>
    replaceParams(new URLSearchParams(id ? { dispatch: id } : {}));
  const rows = held.data?.rows ?? [];

  const senderOf = (row: DispatchSummary) =>
    row.sender && shared.has(row.chain)
      ? (row.sender.name ?? truncateMiddle(row.sender.address, 4, 4))
      : null;

  return (
    <div className={styles.split}>
      <main className={styles.main}>
        <PageBar title="Held">
          {held.data && (
            <span className={styles.muted}>
              {rows.length === 0
                ? 'Nothing waiting'
                : `${count.format(rows.length)}${held.data.complete ? '' : '+'} waiting, oldest first`}
            </span>
          )}
        </PageBar>
        <DispatchRows
          rows={rows}
          selected={selected}
          onSelect={select}
          today={now}
          senderOf={senderOf}
          statusOf={(row) => (
            <span className={ops.heldFor}>{duration(now.getTime() - row.createdAt.getTime())}</span>
          )}
          empty={
            held.error ? (
              <p className={styles.noRows}>{describeFailure(held.error.failure)}</p>
            ) : !held.data ? (
              <p className={styles.noRows}>Loading held Dispatches</p>
            ) : (
              <EmptyState
                caption="Nothing is held. A Managed Dispatch that matches an enabled Flag Rule waits here until you release or cancel it."
                action={
                  <Link page="rules" className={styles.allLink}>
                    Flag Rules ›
                  </Link>
                }
              />
            )
          }
        />
      </main>
      {selected && (
        <HeldPane
          key={selected}
          id={selected}
          now={now}
          onClose={() => select(null)}
          onSettled={() => {
            held.reload();
            select(null);
          }}
        />
      )}
    </div>
  );
}

type Shown = 'matched' | 'all';

interface HeldRow {
  item: Item;
  rules: string[] | undefined;
}

const COLUMNS: readonly Column<HeldRow>[] = [
  {
    id: 'index',
    header: '#',
    width: '32px',
    render: (row) => <span className={styles.muted}>{row.item.index + 1}</span>,
  },
  {
    id: 'target',
    header: 'Recipient',
    width: 'minmax(0, 1fr)',
    render: (row) => <MonoValue value={itemTarget(row.item)} head={5} tail={4} />,
  },
  {
    id: 'amount',
    header: 'Amount',
    width: '108px',
    align: 'end',
    render: ({ item }) =>
      item.type !== 'payment' ? (
        <span className={styles.muted}>Call</span>
      ) : item.amount ? (
        <Amount {...item.amount} />
      ) : (
        <span className={styles.muted}>{item.asset}</span>
      ),
  },
  {
    id: 'rules',
    header: 'Matched',
    width: 'minmax(0, 0.9fr)',
    render: (row) => row.rules?.join(', ') ?? <span className={styles.muted}>None</span>,
  },
];

/** Why one Dispatch is held, its matched items tinted, and the two decisions: Release or Cancel. */
function HeldPane({
  id,
  now,
  onClose,
  onSettled,
}: {
  id: string;
  now: Date;
  onClose: () => void;
  onSettled: () => void;
}) {
  const toast = useToast();
  const { refresh } = useLive();
  const loaded = useDispatch(id);
  const [shown, setShown] = useState<Shown>('matched');
  const [modal, setModal] = useState<'release' | 'cancel' | null>(null);
  const summary = loaded.data?.summary;
  const detail = loaded.data?.detail.mode === 'managed' ? loaded.data.detail : null;
  const hold = detail?.hold ?? null;

  const byItem = useMemo(() => (hold ? matchedItems(hold) : new Map<number, string[]>()), [hold]);
  const rows = useMemo<HeldRow[]>(
    () =>
      (detail?.items ?? []).flatMap((item) => {
        const rules = byItem.get(item.index);
        return shown === 'all' || rules ? [{ item, rules }] : [];
      }),
    [detail, byItem, shown],
  );

  const head: PaneHead = summary
    ? {
        id,
        mode: 'managed',
        name: dispatchName(summary),
        when: whenText(summary.createdAt),
        totals: summary.totals,
        status: summary.status,
      }
    : { id, mode: 'managed', name: 'Loading', when: ' ', totals: [], status: 'held' };

  const settle = (message: string) => {
    setModal(null);
    toast(message);
    refresh();
    onSettled();
  };

  return (
    <>
      <DockedPane
        title="Held Dispatch"
        meta={<MonoValue value={id} head={8} tail={4} />}
        label="Held Dispatch detail"
        onClose={onClose}
        footer={
          detail?.status === 'held' ? (
            <div className={ops.footerActions}>
              <Button variant="danger" onClick={() => setModal('cancel')}>
                Cancel Dispatch
              </Button>
              <Button variant="primary" onClick={() => setModal('release')}>
                Release
              </Button>
            </div>
          ) : undefined
        }
      >
        {!detail || !summary ? (
          <p className={styles.paneNote} role={loaded.error ? 'alert' : undefined}>
            {loaded.error
              ? describeFailure(loaded.error.failure)
              : loaded.data
                ? 'A Relay Dispatch is never held.'
                : 'Loading the Dispatch'}
          </p>
        ) : (
          <>
            <div className={styles.summary}>
              <div className={styles.muted}>{head.when}</div>
              <div className={styles.summaryLine}>
                <span className={styles.summaryName}>{head.name}</span>
                {head.totals[0] && (
                  <span className={styles.summaryTotal}>
                    <Amount {...head.totals[0]} variant="raised" />
                  </span>
                )}
              </div>
              <div className={styles.summaryPill}>
                <StatusPill status={summary.status} />
              </div>
            </div>
            <HoldSection detail={detail} hold={hold} now={now} />
            <div className={ops.heldItems}>
              <div className={styles.chips} role="group" aria-label="Which items to show">
                <ShownChip
                  label="Matched"
                  n={byItem.size}
                  on={shown === 'matched'}
                  onClick={() => setShown('matched')}
                />
                <ShownChip
                  label="All"
                  n={detail.items.length}
                  on={shown === 'all'}
                  onClick={() => setShown('all')}
                />
              </div>
              <VirtualTable
                label={`Items, ${count.format(rows.length)} shown`}
                rows={rows}
                columns={COLUMNS}
                rowKey={(row) => row.item.index}
                marked={(row) => row.rules !== undefined}
                height={320}
                empty={<p className={styles.noRows}>No items matched a rule.</p>}
              />
            </div>
          </>
        )}
      </DockedPane>
      {detail && summary && (
        <>
          <ReleaseModal
            open={modal === 'release'}
            head={head}
            itemCount={detail.items.length}
            onClose={() => setModal(null)}
            onReleased={() => settle(`${head.name} released`)}
          />
          <CancelModal
            open={modal === 'cancel'}
            head={head}
            itemCount={detail.items.length}
            onClose={() => {
              setModal(null);
              loaded.reload();
            }}
            onCancelled={() => settle(`${head.name} cancelled`)}
          />
        </>
      )}
    </>
  );
}

function ShownChip(props: { label: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={styles.chip} aria-pressed={props.on} onClick={props.onClick}>
      {props.label}
      <span className={styles.chipCount}>{count.format(props.n)}</span>
    </button>
  );
}

function itemsText(items: number[], total: number): string {
  if (items.length === total && total > 1) return `All ${count.format(total)} items`;
  if (items.length > 4) return `${count.format(items.length)} of ${count.format(total)} items`;
  const positions = items.map((i) => count.format(i + 1));
  const list =
    positions.length === 1
      ? positions[0]
      : `${positions.slice(0, -1).join(', ')} and ${positions.at(-1)}`;
  return `Item${items.length === 1 ? '' : 's'} ${list}`;
}

function HoldSection({
  detail,
  hold,
  now,
}: {
  detail: ManagedDetail;
  hold: Hold | null;
  now: Date;
}) {
  if (!hold) {
    return (
      <div className={ops.section}>
        <p className={ops.settled}>This Dispatch was never held.</p>
      </div>
    );
  }
  const settled =
    detail.status === 'held'
      ? `Held for ${duration(now.getTime() - hold.heldAt.getTime())}. Nothing is signed until you decide.`
      : hold.releasedAt
        ? `Released ${clock.format(hold.releasedAt)}: ${hold.reason ?? 'no reason given'}.`
        : 'No longer held.';
  return (
    <div className={ops.section}>
      <h3 className={ops.sectionTitle}>
        {hold.matched.length === 1
          ? 'Held by one rule'
          : `Held by ${count.format(hold.matched.length)} rules`}
      </h3>
      <ul className={ops.matches}>
        {hold.matched.map((match) => (
          <li key={`${match.ruleId}-${match.ruleVersion}`} className={ops.match}>
            <span className={ops.matchName}>{match.name}</span>
            <span className={ops.matchCheck}>{describeCheck(match.check, detail.chain)}</span>
            <span className={ops.matchItems}>
              {itemsText(match.items, detail.items.length)}, version {match.ruleVersion}
            </span>
          </li>
        ))}
      </ul>
      <p className={ops.settled}>{settled}</p>
    </div>
  );
}
