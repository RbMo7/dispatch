import { animate, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Amount } from '../../components/Amount';
import { Card } from '../../components/Card';
import { ChainDot } from '../../components/ChainDot';
import { EmptyState } from '../../components/EmptyState';
import { EyeToggle } from '../../components/EyeToggle';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StackedBar } from '../../components/StackedBar';
import { StatusPill } from '../../components/StatusPill';
import { share } from '../../domain/assets';
import { CHAINS } from '../../domain/chains';
import { dispatchName, type DispatchSummary, shortId } from '../../domain/dispatch';
import { duration } from '../../domain/dispatchFlow';
import { free, headlineAsset, isShort, payer, senderKey } from '../../domain/sender';
import { AREA_LABEL, type Setup } from '../../domain/setup';
import { describeFailure } from '../api/client';
import styles from '../console.module.css';
import { useHeld } from '../held/heldData';
import { nextDelay, SENDERS_MS, usePoll } from '../live';
import { Link, type Page, PAGES } from '../router';
import { useSenders } from '../senderData';
import { useApi, useOperator } from '../session';
import { useSetup } from '../setup/setupData';
import { PageBar } from '../Shell';
import {
  loadHistory,
  loadPulse,
  type Pulse,
  pulseInFlight,
  type Range,
  RANGES,
  series,
  settledToday,
  type Walk,
} from './overviewData';

const count = new Intl.NumberFormat('en-US');
const atLeast = (walk: Walk) => `${count.format(walk.rows.length)}${walk.complete ? '' : '+'}`;

const dispatchLink = (id: string) => new URLSearchParams({ dispatch: id });

export function Overview() {
  const api = useApi();
  const [range, setRange] = useState<Range>('24h');
  const loadP = useCallback((signal: AbortSignal) => loadPulse(api, signal), [api]);
  const pulse = usePoll({
    key: 'pulse',
    load: loadP,
    delay: (data, previous) => nextDelay(pulseInFlight(data), previous),
  });
  const loadH = useCallback(
    (signal: AbortSignal) => loadHistory(api, range, new Date(), signal),
    [api, range],
  );
  const history = usePoll({ key: `history:${range}`, load: loadH, delay: () => SENDERS_MS });
  const setup = useSetup();
  const operator = useOperator();
  // ADR-0062: only the operator token reads the refused-request record.
  const loadR = useCallback(
    async (signal: AbortSignal) =>
      operator ? (await api.listRejected(null, signal, 1)).last24Hours : null,
    [api, operator],
  );
  const rejected = usePoll({ key: 'rejected-count', load: loadR, delay: () => SENDERS_MS });

  return (
    <main className={styles.main}>
      <PageBar title="Overview">
        <EyeToggle />
      </PageBar>
      <div className={styles.pageBody}>
        <div className={styles.overview}>
          <InFlightCard
            pulse={pulse.data}
            error={pulse.error ? describeFailure(pulse.error.failure) : null}
            rows={history.data?.rows.rows}
            range={range}
            onRange={setRange}
          />
          <SendersCard />
          <AttentionCard
            pulse={pulse.data}
            attention={history.data?.attention}
            settled={history.data ? settledToday(history.data.rows.rows, new Date()) : null}
            setup={setup.data}
            rejected={rejected.data ?? null}
          />
          <Card
            title="Recent"
            link={{ label: 'View all', href: PAGES.dispatches }}
            className={styles.wide}
          >
            {pulse.data ? (
              pulse.data.recent.length === 0 ? (
                <EmptyState caption="No Dispatches yet. Send the first one with POST /v1/dispatch." />
              ) : (
                <ul className={styles.recent}>
                  {pulse.data.recent.map((row) => (
                    <RecentRow key={row.id} row={row} />
                  ))}
                </ul>
              )
            ) : (
              <p className={styles.cardNote}>
                {pulse.error ? describeFailure(pulse.error.failure) : 'Loading'}
              </p>
            )}
          </Card>
        </div>
      </div>
    </main>
  );
}

function AnimatedNumber({ value, suffix = '' }: { value: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const reduced = useReducedMotion();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (reduced || shown.current === value) {
      shown.current = value;
      node.textContent = `${count.format(value)}${suffix}`;
      return;
    }
    const controls = animate(shown.current, value, {
      duration: 0.4,
      ease: [0.2, 0, 0, 1],
      onUpdate: (latest) => {
        node.textContent = `${count.format(Math.round(latest))}${suffix}`;
      },
    });
    shown.current = value;
    return () => controls.stop();
  }, [value, suffix, reduced]);
  return <span ref={ref}>{`${count.format(value)}${suffix}`}</span>;
}

function InFlightCard({
  pulse,
  error,
  rows,
  range,
  onRange,
}: {
  pulse: Pulse | undefined;
  error: string | null;
  rows: DispatchSummary[] | undefined;
  range: Range;
  onRange: (range: Range) => void;
}) {
  const now = useMemo(() => new Date(), [rows]);
  const data = useMemo(() => (rows ? series(rows, range, now) : null), [rows, range, now]);
  const label = RANGES.find((r) => r.value === range)!;
  const span = { '1h': 'hour', '24h': '24 hours', '7d': '7 days' }[range];

  return (
    <Card title="In flight" link={{ label: 'Dispatches', href: PAGES.dispatches }}>
      <div className={styles.inFlight}>
        {pulse ? (
          <>
            <div className={styles.bigNumber}>
              <AnimatedNumber
                value={pulse.queued.rows.length + pulse.broadcasting.rows.length}
                suffix={pulse.queued.complete && pulse.broadcasting.complete ? '' : '+'}
              />
            </div>
            <div className={styles.muted}>
              {atLeast(pulse.queued)} queued, {atLeast(pulse.broadcasting)} broadcasting
            </div>
          </>
        ) : (
          <div className={styles.muted}>{error ?? 'Loading'}</div>
        )}
      </div>
      {data && <Chart current={data.current} previous={data.previous} />}
      {data && (
        <p className={styles.chartCaption}>
          {count.format(data.created)} created in the last {span}
          {data.created > 0 &&
            `: ${count.format(data.byStatus.get('confirmed') ?? 0)} confirmed, ${count.format(
              (data.byStatus.get('failed') ?? 0) + (data.byStatus.get('partial') ?? 0),
            )} failed or partial, ${count.format(data.byStatus.get('abandoned') ?? 0)} abandoned`}
        </p>
      )}
      <div className={styles.center}>
        <SegmentedControl
          label={`Range, ${label.label}`}
          options={RANGES}
          value={range}
          onChange={onRange}
        />
      </div>
    </Card>
  );
}

/** Cumulative Dispatches created over the range, against the range before it as a dashed pace line. */
function Chart({ current, previous }: { current: number[]; previous: number[] }) {
  const W = 320;
  const H = 70;
  const top = Math.max(1, current.at(-1) ?? 0, previous.at(-1) ?? 0);
  const path = (values: number[]) =>
    values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * W;
        const y = H - 6 - (v / top) * (H - 12);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  const last = current.at(-1) ?? 0;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      aria-hidden="true"
      className={styles.chart}
    >
      <path
        d={path(previous)}
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth="1"
        strokeDasharray="3 4"
      />
      <path
        d={path(current)}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={W - 4}
        cy={H - 6 - (last / top) * (H - 12)}
        r="3.5"
        fill="var(--surface)"
        stroke="var(--accent)"
        strokeWidth="2"
      />
    </svg>
  );
}

function SendersCard() {
  const { data, error } = useSenders();
  return (
    <Card title="Senders" link={{ label: 'Senders & Keys', href: PAGES.senders }}>
      {!data ? (
        <p className={styles.cardNote}>{error ? describeFailure(error.failure) : 'Loading'}</p>
      ) : data.length === 0 ? (
        <p className={styles.cardNote}>No chain is enabled.</p>
      ) : (
        <div className={styles.senderRows}>
          {data.map((sender) => {
            const holding = payer(sender);
            const headline = holding && headlineAsset(holding);
            if (!headline) return null;
            const balance = headline.balance;
            const short = balance.ok && isShort(balance.value, headline.committed);
            return (
              <div key={senderKey(sender)}>
                <div className={styles.senderRowLine}>
                  <ChainDot chain={sender.chain}>{sender.name}</ChainDot>
                  {balance.ok ? (
                    <Amount {...balance.value} />
                  ) : (
                    <span className={styles.fieldError}>{balance.error}</span>
                  )}
                </div>
                {balance.ok && (
                  <>
                    <div className={styles.senderBar}>
                      <StackedBar
                        committed={share(headline.committed, balance.value)}
                        low={short}
                      />
                    </div>
                    <div className={styles.help}>
                      <Amount {...headline.committed} variant="plain" /> committed,{' '}
                      <span className={short ? styles.short : undefined}>
                        <Amount {...free(balance.value, headline.committed)} variant="plain" /> free
                      </span>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

type AttentionEntry = {
  id: string;
  title: string;
  /** A Dispatch's short id, beside the title. */
  mono?: string;
  detail: string;
  page: Page;
  params?: URLSearchParams;
};

function dispatchEntry(
  id: string,
  title: string,
  detail: string,
  row: DispatchSummary,
): AttentionEntry {
  return {
    id,
    title,
    mono: shortId(row.id),
    detail,
    page: 'dispatches',
    params: dispatchLink(row.id),
  };
}

function AttentionCard({
  pulse,
  attention,
  settled,
  setup,
  rejected,
}: {
  pulse: Pulse | undefined;
  attention:
    | {
        awaiting: { summary: DispatchSummary; items: number }[];
        abandoned: { summary: DispatchSummary; items: number }[];
      }
    | undefined;
  settled: number | null;
  setup: Setup | undefined;
  /** Requests refused in the last 24 hours; null outside an operator session. */
  rejected: number | null;
}) {
  const oldest = pulse?.queued.complete ? pulse.queued.rows.at(-1) : undefined;
  const held = useHeld().data;
  const oldestHold = held?.complete ? held.rows[0] : undefined;
  const operator = useOperator();
  const now = Date.now();
  const entries: AttentionEntry[] = [];
  for (const check of setup?.checks ?? []) {
    if (check.status !== 'fail') continue;
    entries.push({
      id: `setup-${check.id}`,
      title: 'Setup problem',
      detail: `${AREA_LABEL[check.area]}, ${check.title}: ${check.finding}`,
      page: 'setup',
    });
  }
  if (rejected) {
    entries.push({
      id: 'rejected',
      title: 'Refused requests',
      detail: `${count.format(rejected)} in the last 24 hours, each with what to fix`,
      page: 'rejected',
    });
  }
  if (oldest) {
    entries.push(
      dispatchEntry(
        `oldest-${oldest.id}`,
        'Oldest unclaimed',
        `${dispatchName(oldest)}, waiting ${duration(now - oldest.createdAt.getTime())}`,
        oldest,
      ),
    );
  }
  if (oldestHold) {
    const others = (held?.rows.length ?? 1) - 1;
    entries.push({
      ...dispatchEntry(
        `held-${oldestHold.id}`,
        'Oldest hold',
        `${dispatchName(oldestHold)}, held ${duration(now - oldestHold.createdAt.getTime())}${others > 0 ? `, ${count.format(others)} more held` : ''}`,
        oldestHold,
      ),
      // ADR-0057: only the operator token can release, so only its session opens the queue.
      ...(operator ? { page: 'held' as const } : {}),
    });
  }
  for (const { summary, items } of attention?.awaiting ?? []) {
    entries.push(
      dispatchEntry(
        `awaiting-${summary.id}`,
        'Awaiting approval',
        `${count.format(items)} ${items === 1 ? 'item' : 'items'} in an open Proposal`,
        summary,
      ),
    );
  }
  for (const { summary, items } of attention?.abandoned ?? []) {
    entries.push(
      dispatchEntry(
        `abandoned-${summary.id}`,
        'Abandoned',
        `${count.format(items)} ${items === 1 ? 'item' : 'items'} with no answer; may still land`,
        summary,
      ),
    );
  }

  return (
    <Card title="Needs attention">
      {!pulse || !attention ? (
        <p className={styles.cardNote}>Loading</p>
      ) : entries.length === 0 ? (
        <EmptyState
          caption={`Nothing needs you. ${count.format(settled ?? 0)} ${settled === 1 ? 'Dispatch' : 'Dispatches'} settled today.`}
        />
      ) : (
        <ul className={styles.attention}>
          {entries.map((entry) => (
            <li key={entry.id}>
              <Link page={entry.page} params={entry.params} className={styles.attentionRow}>
                <span className={styles.attentionTitle}>{entry.title}</span>
                <span className={styles.mono}>{entry.mono}</span>
                <span className={styles.attentionDetail}>{entry.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentRow({ row }: { row: DispatchSummary }) {
  return (
    <li>
      <Link page="dispatches" params={dispatchLink(row.id)} className={styles.recentRow}>
        <span className={styles.rowName}>{dispatchName(row)}</span>
        <span className={styles.mono}>{shortId(row.id)}</span>
        <span className={styles.rowSub}>{CHAINS[row.chain].label}</span>
        <span className={styles.spacer} />
        <StatusPill status={row.status} />
        <span className={styles.rowAmount}>
          {row.totals[0] ? (
            <Amount {...row.totals[0]} />
          ) : (
            <span className={styles.rowSub}>{row.mode === 'relay' ? 'Relay' : 'Calls'}</span>
          )}
        </span>
      </Link>
    </li>
  );
}
