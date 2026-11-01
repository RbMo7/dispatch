import { useCallback, useMemo, useState } from 'react';

import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { TextView } from '../../components/FlowGraph';
import { Pill } from '../../components/StatusPill';
import { CHAINS } from '../../domain/chains';
import { dayKey } from '../../domain/dateRange';
import { explainError } from '../../domain/errors';
import { ApiError, describeFailure } from '../api/client';
import type { RejectedPage as Page, RejectedRequest } from '../api/parse';
import styles from '../console.module.css';
import { dayHeading } from '../dispatches/DispatchRows';
import { SENDERS_MS, usePoll } from '../live';
import ops from '../operator.module.css';
import { useApi } from '../session';
import { PageBar } from '../Shell';

const time = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const count = new Intl.NumberFormat('en-US');

/** ADR-0062: every refused `POST /v1/dispatch`, newest first, by day, with what it means and how to fix it. */
export function RejectedPage() {
  const api = useApi();
  const load = useCallback((signal: AbortSignal) => api.listRejected(null, signal), [api]);
  const polled = usePoll({ key: 'rejected', load, delay: () => SENDERS_MS });
  const [older, setOlder] = useState<{ after: string; pages: Page[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const first = polled.data;
  // Older pages hang off the first page they were loaded after; a new first page starts over.
  const extra = older && first && older.after === first.nextCursor ? older.pages : [];
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return [first, ...extra].flatMap((page) =>
      (page?.rejected ?? []).filter((r) => !seen.has(r.id) && seen.add(r.id)),
    );
  }, [first, extra]);
  const next = (extra.at(-1) ?? first)?.nextCursor ?? null;

  async function loadMore() {
    if (!next || !first) return;
    setLoading(true);
    setMoreError(null);
    try {
      const page = await api.listRejected(next);
      setOlder({ after: first.nextCursor ?? '', pages: [...extra, page] });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setMoreError(describeFailure(error.failure));
    } finally {
      setLoading(false);
    }
  }

  const today = new Date();
  const days = new Map<string, RejectedRequest[]>();
  for (const row of rows) {
    const key = dayKey(row.at);
    days.set(key, [...(days.get(key) ?? []), row]);
  }

  return (
    <main className={styles.main}>
      <PageBar title="Rejected">
        {first && (
          <span className={styles.muted}>
            {count.format(first.last24Hours)} in the last 24 hours
          </span>
        )}
      </PageBar>
      <div className={styles.list}>
        {!polled.data ? (
          <p className={styles.noRows}>
            {polled.error ? describeFailure(polled.error.failure) : 'Loading refused requests'}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState caption="Nothing refused. A request the engine turns away, such as a payment in an unknown asset, is listed here for 30 days." />
        ) : (
          [...days].map(([key, dayRows]) => (
            <section key={key} aria-label={dayHeading(dayRows[0]!.at, today)}>
              <div className={styles.dayHead}>{dayHeading(dayRows[0]!.at, today)}</div>
              {dayRows.map((row) => (
                <RejectedRow key={row.id} row={row} />
              ))}
            </section>
          ))
        )}
        {next && (
          <div className={styles.listEnd}>
            <Button variant="secondary" disabled={loading} onClick={() => void loadMore()}>
              {loading ? 'Loading' : 'Load older'}
            </Button>
            {moreError && <p className={ops.formError}>{moreError}</p>}
          </div>
        )}
      </div>
    </main>
  );
}

function RejectedRow({ row }: { row: RejectedRequest }) {
  const [open, setOpen] = useState(false);
  const explained = explainError(row.error, { chain: row.chain });
  const facts = [
    row.chain ? CHAINS[row.chain].label : 'No chain',
    row.idempotencyKey ? `key ${row.idempotencyKey}` : 'no Idempotency-Key',
    row.tokenKind === 'operator' ? 'operator token' : 'API token',
  ].join(', ');
  return (
    <div className={ops.rejectedRow}>
      <span className={ops.activityTime}>{time.format(row.at)}</span>
      <span className={ops.rejectedCode}>
        <Pill tone="failed" label={row.error.code ?? `HTTP ${row.status}`} />
      </span>
      <div className={ops.rejectedBody}>
        <p className={ops.rejectedTitle}>{explained.title}</p>
        <p className={ops.rejectedText}>
          <TextView text={explained.text} /> {explained.next}
        </p>
        <p className={ops.rejectedFacts}>{facts}</p>
        {open && (
          <pre className={ops.rejectedJson} aria-label="Request body">
            {row.body === null ? 'The body was not JSON.' : JSON.stringify(row.body, null, 2)}
          </pre>
        )}
      </div>
      <div className={ops.rejectedActions}>
        {explained.fix && (
          <a className={ops.rejectedFix} href={explained.fix.href}>
            {explained.fix.label} ›
          </a>
        )}
        <Button variant="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide body' : 'Show body'}
        </Button>
      </div>
    </div>
  );
}
