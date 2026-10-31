import { DownloadSimple } from '@phosphor-icons/react';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { DateRangeControl } from '../../components/DateRangeControl';
import { FilterMenu, type FilterGroup } from '../../components/FilterMenu';
import { Menu } from '../../components/Menu';
import { MonoValue } from '../../components/MonoValue';
import { SearchField } from '../../components/SearchField';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { CHAINS, type Chain, proposalApp, proposalUrl } from '../../domain/chains';
import { dispatchName, type EntryOf, type Item, type LoadedDispatch } from '../../domain/dispatch';
import { dispatchFlow } from '../../domain/dispatchFlow';
import { payer } from '../../domain/sender';
import { STATUSES } from '../../domain/status';
import { dispatchColumns, ITEM_COLUMNS } from '../../export/columns';
import {
  dispatchesFileName,
  download,
  EXPORT_FORMATS,
  type ExportFormat,
  exportFile,
  itemsFileName,
} from '../../export/download';
import { Modal } from '../../motion/Overlay';
import { describeFailure, isUuid } from '../api/client';
import styles from '../console.module.css';
import { useRouter } from '../router';
import { useSenders } from '../senderData';
import { useApi } from '../session';
import { PageBar } from '../Shell';
import { CancelModal } from './CancelModal';
import { useDispatch, useDispatchList } from './data';
import { DispatchPane, type PaneHead } from './DispatchPane';
import { dayHeading, DispatchRows } from './DispatchRows';
import { collectDispatches, matchesSearch } from './exportList';
import {
  type DispatchesQuery,
  LIST_STATUSES,
  listFilters,
  listKey,
  readQuery,
  writeQuery,
} from './query';

const count = new Intl.NumberFormat('en-US');
const rowsText = (n: number) => `${count.format(n)} ${n === 1 ? 'row' : 'rows'}`;
const clock = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const minute = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const full = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const CHAIN_OPTIONS = [
  { value: 'all', label: 'All' },
  ...(Object.keys(CHAINS) as Chain[]).map((chain) => ({
    value: chain,
    label: CHAINS[chain].label,
  })),
];

/** Below this page width the chain control moves into the Filters menu while the pane is open. */
const ROOMY = 1500;

export function DispatchesPage() {
  const { params, replaceParams } = useRouter();
  const today = useMemo(() => new Date(), []);
  const query = useMemo(() => readQuery(params, today), [params, today]);
  const set = useCallback(
    (change: Partial<DispatchesQuery>) => replaceParams(writeQuery({ ...query, ...change })),
    [query, replaceParams],
  );

  const filters = useMemo(() => listFilters(query), [query]);
  const list = useDispatchList(listKey(query), filters);
  const rows = useMemo(
    () => (list.snap?.rows ?? []).filter((row) => matchesSearch(row, query.search)),
    [list.snap, query.search],
  );
  const known = list.snap?.rows.find((row) => row.id === query.selected);
  const selected = useDispatch(query.selected, known);
  const roomy = useWidth() >= ROOMY;
  const compact = query.selected !== null && !roomy;

  const select = useCallback(
    (id: string | null) => set({ selected: id, tab: 'flow', items: 'all' }),
    [set],
  );

  useListKeys(query.selected, select);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const needle = query.search.trim().toLowerCase();
    if (isUuid(needle)) return select(needle);
    const matches = (list.snap?.rows ?? []).filter((row) => row.id.startsWith(needle));
    if (needle && matches.length === 1) select(matches[0]!.id);
  }

  const groups: FilterGroup[] = [
    {
      id: 'status',
      label: 'Status',
      value: query.status,
      options: [
        { value: 'all', label: 'Any status' },
        ...LIST_STATUSES.map((status) => ({ value: status, label: STATUSES[status].label })),
      ],
      onChange: (status) => set({ status: status as DispatchesQuery['status'] }),
    },
    {
      id: 'mode',
      label: 'Mode',
      value: query.mode,
      options: [
        { value: 'all', label: 'Any mode' },
        { value: 'managed', label: 'Managed' },
        { value: 'relay', label: 'Relay' },
      ],
      onChange: (mode) => set({ mode: mode as DispatchesQuery['mode'] }),
    },
    ...(compact
      ? [
          {
            id: 'chain',
            label: 'Chain',
            value: query.chain,
            options: CHAIN_OPTIONS.map((o) =>
              o.value === 'all' ? { ...o, label: 'Any chain' } : o,
            ),
            onChange: (chain: string) => set({ chain: chain as DispatchesQuery['chain'] }),
          },
        ]
      : []),
  ];

  const exporter = useListExport(query);

  return (
    <div className={styles.split}>
      <main className={styles.main}>
        <PageBar title="Dispatches">
          <DateRangeControl
            value={query.range}
            onChange={(range) => set({ range })}
            today={today}
          />
          {!compact && (
            <SegmentedControl
              label="Chain"
              options={CHAIN_OPTIONS}
              value={query.chain}
              onChange={(chain) => set({ chain: chain as DispatchesQuery['chain'] })}
            />
          )}
          <FilterMenu label="Filters" groups={groups} />
          <form role="search" onSubmit={submitSearch}>
            <SearchField
              label="Search Dispatches by id"
              placeholder="Search id"
              value={query.search}
              onChange={(search) => {
                set({ search });
                if (isUuid(search.trim())) select(search.trim().toLowerCase());
              }}
              width={compact ? 120 : 150}
            />
          </form>
          <Menu
            label="Export"
            icon={<DownloadSimple size={14} aria-hidden="true" />}
            items={EXPORT_FORMATS.map((format) => ({
              id: format.id,
              label: format.label,
              onSelect: () => exporter.start(format.id),
            }))}
          />
        </PageBar>
        <DispatchRows
          rows={rows}
          selected={query.selected}
          onSelect={select}
          today={today}
          empty={
            <ListEmpty
              loading={!list.snap}
              error={list.error ? describeFailure(list.error.failure) : null}
            />
          }
          footer={
            list.snap?.hasMore ? (
              <Sentinel onVisible={() => void list.loadMore()} busy={list.loadingMore} />
            ) : rows.length > 0 ? (
              <p className={styles.listEnd}>{rowsText(rows.length)}, the end of this range</p>
            ) : null
          }
        />
      </main>
      {query.selected && (
        <Pane
          id={query.selected}
          loaded={selected.data}
          error={selected.error ? describeFailure(selected.error.failure) : null}
          reload={selected.reload}
          query={query}
          set={set}
          onClose={() => select(null)}
        />
      )}
      {exporter.modal}
    </div>
  );
}

function ListEmpty({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) return <p className={styles.noRows}>{error}</p>;
  if (loading) return <p className={styles.noRows}>Loading Dispatches</p>;
  return <p className={styles.noRows}>No Dispatches match these filters.</p>;
}

function Sentinel({ onVisible, busy }: { onVisible: () => void; busy: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current();
      },
      { root: node.closest('[data-dispatch-list]'), rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [busy]);
  return (
    <p ref={ref} className={styles.listEnd}>
      {busy ? 'Loading more' : ' '}
    </p>
  );
}

function useWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** `j` / `k` move through rows, `Enter` opens the focused one (it is a button), `Esc` closes the pane. */
function useListKeys(selected: string | null, select: (id: string | null) => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target.closest('input, textarea, [role="dialog"], [role="menu"]')
      )
        return;
      if (event.key === 'Escape') {
        if (selected) select(null);
        return;
      }
      if (event.key !== 'j' && event.key !== 'k') return;
      const buttons = [
        ...document.querySelectorAll<HTMLElement>('[data-dispatch-list] [data-row]'),
      ];
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement as HTMLElement);
      const from = at === -1 ? buttons.findIndex((b) => b.dataset.row === selected) : at;
      const next =
        event.key === 'j' ? Math.min(buttons.length - 1, from + 1) : Math.max(0, from - 1);
      buttons[next]?.focus();
      buttons[next]?.scrollIntoView({ block: 'nearest' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected, select]);
}

/** Walks every page for the current filters, with a progress count and Cancel, then saves the file. */
function useListExport(query: DispatchesQuery) {
  const api = useApi();
  const toast = useToast();
  const [state, setState] = useState<{ read: number; error: string | null } | null>(null);
  const controller = useRef<AbortController | null>(null);

  async function start(format: ExportFormat) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ read: 0, error: null });
    try {
      const rows = await collectDispatches(
        api,
        listFilters(query),
        query.search,
        (read) => setState({ read, error: null }),
        current.signal,
      );
      if (current.signal.aborted) return;
      const assets = [...new Set(rows.flatMap((row) => row.totals.map((t) => t.asset)))];
      download(
        await exportFile(format, dispatchColumns(assets), rows),
        dispatchesFileName(query.range, format),
      );
      setState(null);
      toast(`Exported ${rowsText(rows.length)}`);
    } catch (error) {
      if (current.signal.aborted) return;
      setState({ read: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const close = () => {
    controller.current?.abort();
    setState(null);
  };

  const modal = (
    <Modal
      open={state !== null}
      title="Export Dispatches"
      onClose={close}
      footer={
        <Button variant="secondary" data-autofocus onClick={close}>
          {state?.error ? 'Close' : 'Cancel'}
        </Button>
      }
    >
      <p className={styles.cancelText} role="status" aria-live="polite">
        {state?.error
          ? `The export stopped: ${state.error}`
          : `Reading every Dispatch that matches the filters: ${count.format(state?.read ?? 0)} so far.`}
      </p>
    </Modal>
  );

  return { start, modal };
}

function Pane({
  id,
  loaded,
  error,
  reload,
  query,
  set,
  onClose,
}: {
  id: string;
  loaded: LoadedDispatch | undefined;
  error: string | null;
  reload: () => void;
  query: DispatchesQuery;
  set: (change: Partial<DispatchesQuery>) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const senders = useSenders();
  const [itemSearch, setItemSearch] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => setNow(new Date()), [loaded]);
  useEffect(() => setItemSearch(''), [id]);

  const flow = useMemo(
    () => (loaded ? dispatchFlow(loaded, { now, time: (at) => clock.format(at) }) : null),
    [loaded, now],
  );

  const head: PaneHead = loaded
    ? {
        id,
        mode: loaded.summary.mode,
        name: dispatchName(loaded.summary),
        when: whenText(loaded.summary.createdAt),
        totals: loaded.summary.totals,
        status: loaded.summary.status,
      }
    : {
        id,
        mode: 'managed',
        name: error ? 'Not found' : 'Loading',
        when: ' ',
        totals: [],
        status: 'queued',
      };

  const detail = loaded?.detail;
  const items = detail?.mode === 'managed' ? detail.items : null;
  const claimed = detail?.timeline.findLast((e): e is EntryOf<'claimed'> => e.kind === 'claimed');
  const cancellable = detail !== undefined && !claimed && detail.status === 'queued';
  const openProposal = items?.find((i) => i.status === 'awaiting_approval' && i.approval)?.approval;
  const hashes = items
    ? items.map((i) => i.transactionHash)
    : [detail?.mode === 'relay' ? detail.transactionHash : null];
  const firstHash = hashes.find((h) => h !== null) ?? null;
  const sender = loaded && senders.data?.find((s) => s.chain === loaded.summary.chain);

  const details = loaded
    ? [
        { label: 'Chain', value: CHAINS[loaded.summary.chain].label },
        { label: 'Mode', value: loaded.summary.mode === 'relay' ? 'Relay' : 'Managed' },
        {
          label: 'Sender',
          value:
            loaded.summary.mode === 'relay' ? (
              'Signed by the caller'
            ) : sender ? (
              <MonoValue value={payer(sender)?.address ?? sender.address} />
            ) : (
              'Unknown'
            ),
        },
        { label: 'Items', value: count.format(loaded.summary.itemCount) },
        { label: 'Created', value: full.format(loaded.summary.createdAt) },
        { label: 'Claimed', value: claimed ? full.format(claimed.at) : 'Not yet' },
        { label: 'Id', value: <MonoValue value={id} head={13} tail={6} /> },
      ]
    : [];

  async function exportItems(format: ExportFormat, shown: readonly Item[]) {
    download(await exportFile(format, ITEM_COLUMNS, shown), itemsFileName(id.slice(0, 8), format));
    toast(`Exported ${rowsText(shown.length)}`);
  }

  return (
    <>
      <DispatchPane
        head={head}
        flow={flow}
        items={items}
        details={details}
        body={
          !loaded ? (
            <p className={styles.paneNote} role={error ? 'alert' : undefined}>
              {error ?? 'Loading the Dispatch and its timeline'}
            </p>
          ) : undefined
        }
        tab={query.tab}
        onTab={(tab) => set({ tab })}
        itemFilter={query.items}
        onItemFilter={(items) => set({ items })}
        itemSearch={itemSearch}
        onItemSearch={setItemSearch}
        onExportItems={(format, shown) => void exportItems(format, shown)}
        explorerHref={firstHash && loaded ? CHAINS[loaded.summary.chain].txUrl(firstHash) : null}
        action={
          cancellable ? (
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Cancel Dispatch
            </Button>
          ) : openProposal ? (
            <Button
              variant="quiet"
              href={proposalUrl(openProposal.chainRef)}
              target="_blank"
              rel="noreferrer"
            >
              Reject it in {proposalApp(openProposal.chainRef)} ›
            </Button>
          ) : undefined
        }
        onClose={onClose}
      />
      {loaded && (
        <CancelModal
          open={confirming}
          head={head}
          itemCount={loaded.summary.itemCount}
          onClose={() => {
            setConfirming(false);
            reload();
          }}
          onCancelled={() => {
            setConfirming(false);
            reload();
            toast(`${head.name} cancelled`);
          }}
        />
      )}
    </>
  );
}

/** "Today, 14:02", "Yesterday, 17:58" or "Oct 4, 2026, 09:15". */
function whenText(at: Date): string {
  const day = dayHeading(at, new Date());
  return `${day === 'Today' || day === 'Yesterday' ? day : date.format(at)}, ${minute.format(at)}`;
}
