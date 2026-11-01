import { useCallback, useMemo, useState } from 'react';

import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import type { KnownAsset } from '../../domain/assets';
import { CHAINS } from '../../domain/chains';
import { dayKey } from '../../domain/dateRange';
import { shortId } from '../../domain/dispatch';
import { ACTIONS, type FlagRule, type OperatorAction } from '../../domain/flagRules';
import { ApiError, describeFailure } from '../api/client';
import type { ActivityPage as Page } from '../api/parse';
import styles from '../console.module.css';
import { dayHeading } from '../dispatches/DispatchRows';
import { SENDERS_MS, usePoll } from '../live';
import ops from '../operator.module.css';
import { Link } from '../router';
import { useAssets } from '../senderData';
import { useApi } from '../session';
import { PageBar } from '../Shell';

const time = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface Loaded {
  first: Page;
  /** Rule names by id, for rule actions: a deleted rule is no longer listed. */
  rules: Map<string, string>;
}

/** The activity record (ADR-0057): every cancel, release, rule and asset change, newest first, by day. */
export function ActivityPage() {
  const api = useApi();
  const load = useCallback(
    async (signal: AbortSignal): Promise<Loaded> => {
      const [first, rules] = await Promise.all([
        api.listActivity(null, signal),
        api.listFlagRules(signal),
      ]);
      return { first, rules: new Map(rules.map((r: FlagRule) => [r.id, r.current.name])) };
    },
    [api],
  );
  const polled = usePoll({ key: 'activity', load, delay: () => SENDERS_MS });
  const assetList = useAssets().data;
  const assets = useMemo(
    () => new Map((assetList ?? []).map((asset) => [asset.id, asset])),
    [assetList],
  );
  const [older, setOlder] = useState<{ after: string; pages: Page[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const first = polled.data?.first;
  // Older pages hang off the first page they were loaded after; a new first page starts over.
  const extra = older && first && older.after === first.nextCursor ? older.pages : [];
  const actions = useMemo(() => {
    const seen = new Set<string>();
    return [first, ...extra].flatMap((page) =>
      (page?.actions ?? []).filter((a) => !seen.has(a.id) && seen.add(a.id)),
    );
  }, [first, extra]);
  const next = (extra.at(-1) ?? first)?.nextCursor ?? null;

  async function loadMore() {
    if (!next || !first) return;
    setLoading(true);
    setMoreError(null);
    try {
      const page = await api.listActivity(next);
      setOlder({ after: first.nextCursor ?? '', pages: [...extra, page] });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setMoreError(describeFailure(error.failure));
    } finally {
      setLoading(false);
    }
  }

  const today = new Date();
  const days = new Map<string, OperatorAction[]>();
  for (const action of actions) {
    const key = dayKey(action.at);
    days.set(key, [...(days.get(key) ?? []), action]);
  }

  return (
    <main className={styles.main}>
      <PageBar title="Activity" />
      <div className={styles.list}>
        {!polled.data ? (
          <p className={styles.noRows}>
            {polled.error ? describeFailure(polled.error.failure) : 'Loading the activity record'}
          </p>
        ) : actions.length === 0 ? (
          <EmptyState caption="No activity yet. Every cancel, release, Flag Rule and asset change is recorded here." />
        ) : (
          [...days].map(([key, rows]) => (
            <section key={key} aria-label={dayHeading(rows[0]!.at, today)}>
              <div className={styles.dayHead}>{dayHeading(rows[0]!.at, today)}</div>
              {rows.map((action) => (
                <ActivityRow
                  key={action.id}
                  action={action}
                  rules={polled.data!.rules}
                  assets={assets}
                />
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

function ActivityRow({
  action,
  rules,
  assets,
}: {
  action: OperatorAction;
  rules: Map<string, string>;
  assets: Map<string, KnownAsset>;
}) {
  const { label, target } = ACTIONS[action.action];
  const ruleName = rules.get(action.targetId);
  const asset = assets.get(action.targetId);
  return (
    <div className={ops.activityRow}>
      <span className={ops.activityTime}>{time.format(action.at)}</span>
      <span className={ops.activityAction}>{label}</span>
      <span className={ops.activityTarget}>
        {target === 'dispatch' ? (
          <Link
            page="dispatches"
            params={new URLSearchParams({ dispatch: action.targetId })}
            className={styles.mono}
          >
            {shortId(action.targetId)}
          </Link>
        ) : target === 'asset' ? (
          asset ? (
            <Link page="assets" params={new URLSearchParams({ chain: asset.chain })}>
              {asset.symbol} on {CHAINS[asset.chain].label}
            </Link>
          ) : (
            <span className={styles.mono}>{shortId(action.targetId)}</span>
          )
        ) : ruleName ? (
          <Link page="rules" params={new URLSearchParams({ rule: action.targetId })}>
            {ruleName}
          </Link>
        ) : (
          <span className={styles.muted}>
            Deleted rule <span className={styles.mono}>{shortId(action.targetId)}</span>
          </span>
        )}
      </span>
      <span className={ops.activityReason} title={action.reason ?? undefined}>
        {action.reason ?? 'No reason given'}
      </span>
      <span className={ops.activityToken}>
        {action.tokenKind === 'operator' ? 'Operator token' : 'API token'}
      </span>
    </div>
  );
}
