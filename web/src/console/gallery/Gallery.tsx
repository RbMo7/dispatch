import { useCallback, useEffect, useMemo, useState } from 'react';

import { BalancesProvider } from '../../balances';
import { Button } from '../../components/Button';
import { ToastProvider, useToast } from '../../components/Toast';
import { type DayRange, inRange, presetRange } from '../../domain/dateRange';
import { itemTarget } from '../../domain/dispatch';
import { dispatchColumns, ITEM_COLUMNS } from '../../export/columns';
import { dispatchesFileName, download, exportFile, itemsFileName } from '../../export/download';
import { Modal } from '../../motion/Overlay';
import { DISPATCHES, FIXTURE_TODAY, type GalleryDispatch, type ShowItems } from '../fixtures';
import { type ChainFilter, DispatchList } from './DispatchList';
import { DispatchPane, type PaneTab } from './DispatchPane';
import styles from './Gallery.module.css';
import { type ItemFilter } from './ItemsTab';
import { CancelSummary, Primitives } from './Primitives';
import { Sidebar } from './Sidebar';

const TABS: readonly PaneTab[] = ['flow', 'items', 'details'];
const count = new Intl.NumberFormat('en-US');

function fromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('dispatch');
  const tab = params.get('tab') as PaneTab | null;
  return {
    selected: id === 'none' ? null : DISPATCHES.some((d) => d.id === id) ? id : DISPATCHES[0]!.id,
    tab: tab && TABS.includes(tab) ? tab : 'flow',
    itemFilter: (params.get('status') ?? 'all') as ItemFilter,
  };
}

export function Gallery() {
  return (
    <BalancesProvider>
      <ToastProvider>
        <Screen />
      </ToastProvider>
    </BalancesProvider>
  );
}

function Screen() {
  const initial = useMemo(fromUrl, []);
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(initial.selected);
  const [tab, setTab] = useState<PaneTab>(initial.tab);
  const [itemFilter, setItemFilter] = useState<ItemFilter>(initial.itemFilter);
  const [itemSearch, setItemSearch] = useState('');
  const [range, setRange] = useState<DayRange>(() => presetRange('7d', FIXTURE_TODAY));
  const [chain, setChain] = useState<ChainFilter>('all');
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [cancelled, setCancelled] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const dispatches = useMemo(
    () =>
      DISPATCHES.map((d): GalleryDispatch =>
        cancelled.has(d.id)
          ? {
              ...d,
              status: 'cancelled',
              items: d.items.map((i) => ({ ...i, status: 'cancelled' as const })),
            }
          : d,
      ),
    [cancelled],
  );

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return dispatches.filter(
      (d) =>
        inRange(range, d.createdAt) &&
        (chain === 'all' || d.chain === chain) &&
        (!needle ||
          d.id.includes(needle) ||
          (d.label ?? '').toLowerCase().includes(needle) ||
          d.sender.toLowerCase().includes(needle) ||
          d.items.some((item) => itemTarget(item).toLowerCase().includes(needle))),
    );
  }, [dispatches, range, chain, search]);

  const dispatch = dispatches.find((d) => d.id === selected) ?? null;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set('dispatch', selected ?? 'none');
    params.set('tab', tab);
    if (itemFilter === 'all') params.delete('status');
    else params.set('status', itemFilter);
    window.history.replaceState(null, '', `?${params}`);
  }, [selected, tab, itemFilter]);

  const select = useCallback((id: string) => {
    setSelected((current) => {
      if (current !== id) {
        setItemFilter('all');
        setItemSearch('');
      }
      return id;
    });
  }, []);

  const showItems = useCallback<ShowItems>((filter) => {
    setTab('items');
    setItemFilter(filter ?? 'all');
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        confirming ||
        event.metaKey ||
        event.ctrlKey ||
        target.closest('input, textarea, [role="dialog"], [role="menu"]')
      )
        return;
      if (event.key === 'Escape') {
        setSelected(null);
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
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirming, selected]);

  async function exportDispatches(format: 'csv' | 'xlsx') {
    const assets = [...new Set(rows.flatMap((d) => d.totals.map((t) => t.asset)))];
    download(
      await exportFile(format, dispatchColumns(assets), rows),
      dispatchesFileName(range, format),
    );
    toast(`Exported ${count.format(rows.length)} ${rows.length === 1 ? 'row' : 'rows'}`);
  }

  return (
    <div className={styles.page}>
      <div className={styles.screen}>
        <Sidebar />
        <DispatchList
          rows={rows}
          selected={selected}
          onSelect={select}
          checked={checked}
          onCheck={(ids, on) =>
            setChecked((current) => {
              const next = new Set(current);
              for (const id of ids) {
                if (on) next.add(id);
                else next.delete(id);
              }
              return next;
            })
          }
          range={range}
          onRange={setRange}
          chain={chain}
          onChain={setChain}
          search={search}
          onSearch={setSearch}
          onExport={(format) => void exportDispatches(format)}
        />
        {dispatch && (
          <DispatchPane
            dispatch={dispatch}
            tab={tab}
            onTab={setTab}
            showItems={showItems}
            itemFilter={itemFilter}
            onItemFilter={setItemFilter}
            itemSearch={itemSearch}
            onItemSearch={setItemSearch}
            onExportItems={(format, items) => {
              void exportFile(format, ITEM_COLUMNS, items).then((blob) => {
                download(blob, itemsFileName(dispatch.id, format));
                toast(
                  `Exported ${count.format(items.length)} ${items.length === 1 ? 'row' : 'rows'}`,
                );
              });
            }}
            onClose={() => setSelected(null)}
            onCancel={() => setConfirming(true)}
          />
        )}
      </div>

      <Primitives onOpenModal={() => setConfirming(true)} />

      <Modal
        open={confirming}
        title="Cancel Dispatch"
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button variant="secondary" data-autofocus onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              variant="danger-filled"
              onClick={() => {
                setCancelled((current) => new Set(current).add('2b6f0a88'));
                setConfirming(false);
                toast('Creator rewards cancelled');
              }}
            >
              Cancel Dispatch
            </Button>
          </>
        }
      >
        <CancelSummary />
      </Modal>
    </div>
  );
}
